package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

const UserIDKey = "user_id"

// Supabase JWT: alg HS256, secret from dashboard. Claims include "sub" (user UUID).
func AuthJWT(jwtSecret string) gin.HandlerFunc {
	return func(c *gin.Context) {
		auth := c.GetHeader("Authorization")
		if auth == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing Authorization header"})
			return
		}
		parts := strings.SplitN(auth, " ", 2)
		if len(parts) != 2 || parts[0] != "Bearer" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid Authorization format"})
			return
		}
		token, err := jwt.Parse(parts[1], func(token *jwt.Token) (interface{}, error) {
			return []byte(jwtSecret), nil
		})
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
			return
		}
		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok || !token.Valid {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token claims"})
			return
		}
		sub, _ := claims["sub"].(string)
		if sub == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing sub claim"})
			return
		}
		c.Set(UserIDKey, sub)
		c.Next()
	}
}

func CORS(origin string) gin.HandlerFunc {
	allowed := make(map[string]bool)
	for _, o := range strings.Split(origin, ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			allowed[o] = true
		}
	}
	return func(c *gin.Context) {
		reqOrigin := c.Request.Header.Get("Origin")
		if reqOrigin != "" {
			if !allowed[reqOrigin] {
				c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "origin not allowed"})
				return
			}
			c.Header("Access-Control-Allow-Origin", reqOrigin)
		}
		c.Header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}
