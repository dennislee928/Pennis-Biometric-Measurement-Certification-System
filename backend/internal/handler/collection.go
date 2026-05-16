package handler

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const (
	labelRecognized    = "recognized"
	labelNotRecognized = "not_recognized"
	maxFileSize        = 2 << 20 // 2MB
)

// SubmitCollection 接收前端上傳的 ROI 圖與標籤，存到 COLLECTION_STORAGE_PATH/{label}/ 下
func SubmitCollection(collectionRoot string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if collectionRoot == "" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "collection not configured"})
			return
		}

		label := strings.TrimSpace(strings.ToLower(c.PostForm("label")))
		if label != labelRecognized && label != labelNotRecognized {
			c.JSON(http.StatusBadRequest, gin.H{"error": "label must be 'recognized' or 'not_recognized'"})
			return
		}

		file, err := c.FormFile("image")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "missing image file"})
			return
		}
		if file.Size > maxFileSize {
			c.JSON(http.StatusBadRequest, gin.H{"error": "image must be smaller than 2MB"})
			return
		}

		f, err := file.Open()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read file"})
			return
		}
		header := make([]byte, 8)
		if _, err := f.Read(header); err != nil {
			f.Close()
			c.JSON(http.StatusBadRequest, gin.H{"error": "failed to read image header"})
			return
		}
		f.Close()

		if !isValidImageHeader(header) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "image must be PNG or JPEG format"})
			return
		}

		dir := filepath.Join(collectionRoot, label)
		if err := os.MkdirAll(dir, 0755); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create directory"})
			return
		}

		ext := filepath.Ext(file.Filename)
		if ext == "" {
			ext = ".png"
		}
		name := fmt.Sprintf("%d_%s%s", time.Now().UnixMilli(), uuid.New().String()[:8], ext)
		dst := filepath.Join(dir, name)
		if err := c.SaveUploadedFile(file, dst); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save file"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"ok": true, "path": name})
	}
}

func isValidImageHeader(header []byte) bool {
	if len(header) < 8 {
		return false
	}
	// PNG: 89 50 4E 47 0D 0A 1A 0A
	if header[0] == 0x89 && header[1] == 0x50 && header[2] == 0x4E && header[3] == 0x47 &&
		header[4] == 0x0D && header[5] == 0x0A && header[6] == 0x1A && header[7] == 0x0A {
		return true
	}
	// JPEG: FF D8 FF
	if header[0] == 0xFF && header[1] == 0xD8 && header[2] == 0xFF {
		return true
	}
	return false
}
