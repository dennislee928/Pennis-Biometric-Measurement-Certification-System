package main

import (
	"log"
	"os"

	"certification-backend/internal/config"
	"certification-backend/internal/db"
	"certification-backend/internal/handler"
	"certification-backend/internal/middleware"

	"github.com/gin-gonic/gin"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	if cfg.DatabaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}
	if cfg.CERTHMACSecret == "" {
		log.Fatal("CERT_HMAC_SECRET is required")
	}
	if cfg.SupabaseJWTSecret == "" {
		log.Fatal("SUPABASE_JWT_SECRET is required")
	}

	database, err := db.Open(cfg.DatabaseURL)
	if err != nil {
		log.Fatal("db open:", err)
	}
	if err := db.AutoMigrate(database); err != nil {
		log.Printf("warning: automigrate: %v", err)
	}

	r := gin.Default()
	r.Use(middleware.CORS(cfg.CORSOrigin))

	r.POST("/webhooks/persona", handler.PersonaWebhook(cfg.PersonaWebhookSecret, database))

	api := r.Group("/api")
	api.POST("/certificates/verify", middleware.RateLimitGet(), handler.VerifyCertificate(cfg.CERTHMACSecret))
	// 資料收集：ROI 圖 + 標籤，不需登入；需設定 COLLECTION_STORAGE_PATH 才啟用
	api.POST("/collection", middleware.RateLimitCollection(), handler.SubmitCollection(cfg.CollectionStoragePath))
	api.Use(middleware.AuthJWT(cfg.SupabaseJWTSecret))
	{
		api.POST("/certificates", middleware.RateLimitCertificate(), handler.IssueCertificate(cfg.CERTHMACSecret, database))
		api.GET("/certificates", middleware.RateLimitGet(), handler.ListCertificates(database))
		api.GET("/certificates/:id", middleware.RateLimitGet(), handler.GetCertificate(database))
		api.DELETE("/certificates/:id", middleware.RateLimitCertificate(), handler.DeleteCertificate(database))
	}

	port := cfg.Port
	if port == "" {
		port = "8080"
	}
	if p := os.Getenv("PORT"); p != "" {
		port = p
	}
	log.Printf("listening on :%s", port)
	if err := r.Run(":" + port); err != nil {
		log.Fatal(err)
	}
}
