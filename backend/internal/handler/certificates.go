package handler

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"certification-backend/internal/middleware"
	"certification-backend/internal/model"

	"github.com/gin-gonic/gin"
	"github.com/go-playground/validator/v10"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

// MeasurementResult matches frontend lib/measurementEngine.MeasurementResult
type MeasurementResult struct {
	LengthCm       float64 `json:"lengthCm"`
	CircumferenceCm *float64 `json:"circumferenceCm,omitempty"`
	Ppm            float64 `json:"ppm"`
	Timestamp      int64   `json:"timestamp"`
	LiveCaptured   bool    `json:"liveCaptured"`
}

type IssueCertificateRequest struct {
	InquiryID  string            `json:"inquiryId" binding:"required"`
	Measurement MeasurementResult `json:"measurement" binding:"required"`
}

type CertificatePayload struct {
	InquiryID   string            `json:"inquiryId"`
	Measurement MeasurementResult `json:"measurement"`
	IssuedAt    string            `json:"issuedAt"`
	Nonce       string            `json:"nonce"`
	Signature   string            `json:"signature"`
}

// buildPayloadString matches frontend createCertificate payload: inquiryId | lengthCm(2) | timestamp | issuedAt | nonce
func buildPayloadString(inquiryID string, m MeasurementResult, issuedAt, nonce string) string {
	return fmt.Sprintf("%s|%.2f|%d|%s|%s",
		inquiryID, m.LengthCm, m.Timestamp, issuedAt, nonce)
}

func signPayload(payloadStr, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payloadStr))
	return hex.EncodeToString(mac.Sum(nil))
}

func IssueCertificate(hmacSecret string, db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		userIDStr, _ := c.Get(middleware.UserIDKey)
		userID, err := uuid.Parse(userIDStr.(string))
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid user id"})
			return
		}

		var req IssueCertificateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if err := validator.New().Struct(req); err != nil {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		if err := validateMeasurement(req.Measurement); err != nil {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		var inquiry model.Inquiry
		if err := db.Where("inquiry_id = ? AND status = ?", req.InquiryID, "approved").First(&inquiry).Error; err != nil {
			if err == gorm.ErrRecordNotFound {
				c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "inquiry not found or not approved"})
				return
			}
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "db error"})
			return
		}

		var existing model.Certificate
		if err := db.Where("inquiry_id = ?", req.InquiryID).First(&existing).Error; err == nil {
			c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "certificate already issued for this inquiry"})
			return
		}

		issuedAt := time.Now().UTC().Format(time.RFC3339)
		nonce := uuid.New().String()
		payloadStr := buildPayloadString(req.InquiryID, req.Measurement, issuedAt, nonce)
		signature := signPayload(payloadStr, hmacSecret)

		measurementJSON, _ := json.Marshal(req.Measurement)
		issuedAtTime, _ := time.Parse(time.RFC3339, issuedAt)

		cert := model.Certificate{
			UserID:      userID,
			InquiryID:   req.InquiryID,
			Measurement: measurementJSON,
			IssuedAt:    issuedAtTime,
			Nonce:       nonce,
			Signature:   signature,
		}
		if err := db.Create(&cert).Error; err != nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "db error"})
			return
		}

		audit := model.AuditLog{
			Action:     "certificate.issued",
			EntityType: strPtr("certificate"),
			EntityID:   strPtr(cert.ID.String()),
			UserID:     &userID,
			InquiryID:  &req.InquiryID,
			Payload:    []byte(fmt.Sprintf(`{"inquiry_id":"%s"}`, req.InquiryID)),
			CreatedAt:  time.Now().UTC(),
		}
		_ = db.Create(&audit)

		resp := CertificatePayload{
			InquiryID:   req.InquiryID,
			Measurement: req.Measurement,
			IssuedAt:    issuedAt,
			Nonce:       nonce,
			Signature:   signature,
		}
		c.JSON(http.StatusOK, resp)
	}
}

func ListCertificates(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		userIDStr, _ := c.Get(middleware.UserIDKey)
		userID, err := uuid.Parse(userIDStr.(string))
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid user id"})
			return
		}

		var certs []model.Certificate
		if err := db.Where("user_id = ?", userID).Order("issued_at DESC").Find(&certs).Error; err != nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "db error"})
			return
		}

		type certItem struct {
			ID        string  `json:"id"`
			InquiryID string  `json:"inquiryId"`
			IssuedAt  string  `json:"issuedAt"`
			LengthCm  float64 `json:"lengthCm"`
			Signature string  `json:"signature"`
		}
		out := make([]certItem, 0, len(certs))
		for _, cert := range certs {
			var m MeasurementResult
			_ = json.Unmarshal(cert.Measurement, &m)
			out = append(out, certItem{
				ID:        cert.ID.String(),
				InquiryID: cert.InquiryID,
				IssuedAt:  cert.IssuedAt.Format(time.RFC3339),
				LengthCm:  m.LengthCm,
				Signature: cert.Signature,
			})
		}
		c.JSON(http.StatusOK, out)
	}
}

func GetCertificate(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		userIDStr, _ := c.Get(middleware.UserIDKey)
		userID, err := uuid.Parse(userIDStr.(string))
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid user id"})
			return
		}
		idStr := c.Param("id")
		certID, err := uuid.Parse(idStr)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid certificate id"})
			return
		}
		var cert model.Certificate
		if err := db.Where("id = ? AND user_id = ?", certID, userID).First(&cert).Error; err != nil {
			if err == gorm.ErrRecordNotFound {
				c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "certificate not found"})
				return
			}
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "db error"})
			return
		}
		var m MeasurementResult
		_ = json.Unmarshal(cert.Measurement, &m)
		c.JSON(http.StatusOK, CertificatePayload{
			InquiryID:   cert.InquiryID,
			Measurement: m,
			IssuedAt:    cert.IssuedAt.Format(time.RFC3339),
			Nonce:       cert.Nonce,
			Signature:   cert.Signature,
		})
	}
}

type VerifyRequest struct {
	InquiryID   string            `json:"inquiryId"`
	Measurement MeasurementResult `json:"measurement"`
	IssuedAt    string            `json:"issuedAt"`
	Nonce       string            `json:"nonce"`
	Signature   string            `json:"signature"`
}

func VerifyCertificate(hmacSecret string) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req VerifyRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error(), "valid": false})
			return
		}
		payloadStr := buildPayloadString(req.InquiryID, req.Measurement, req.IssuedAt, req.Nonce)
		expected := signPayload(payloadStr, hmacSecret)
		valid := hmac.Equal([]byte(req.Signature), []byte(expected))
		if valid {
			c.JSON(http.StatusOK, gin.H{"valid": true, "inquiryId": req.InquiryID, "issuedAt": req.IssuedAt})
		} else {
			c.JSON(http.StatusOK, gin.H{"valid": false})
		}
	}
}
