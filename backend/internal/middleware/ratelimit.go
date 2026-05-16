package middleware

import (
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

type bucket struct {
	tokens    int
	lastCheck time.Time
}

type rateLimiter struct {
	mu       sync.Mutex
	buckets  map[string]*bucket
	capacity int
	refill   time.Duration
}

func newRateLimiter(capacity int, refill time.Duration) *rateLimiter {
	return &rateLimiter{
		buckets:  make(map[string]*bucket),
		capacity: capacity,
		refill:   refill,
	}
}

func (rl *rateLimiter) allow(ip string) (bool, time.Duration) {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	b, ok := rl.buckets[ip]
	now := time.Now()
	if !ok {
		rl.buckets[ip] = &bucket{tokens: rl.capacity - 1, lastCheck: now}
		return true, 0
	}

	elapsed := now.Sub(b.lastCheck)
	refillTokens := int(elapsed / rl.refill)
	if refillTokens > 0 {
		b.tokens += refillTokens
		if b.tokens > rl.capacity {
			b.tokens = rl.capacity
		}
		b.lastCheck = now
	}

	if b.tokens > 0 {
		b.tokens--
		return true, 0
	}

	retryAfter := rl.refill - elapsed%rl.refill
	if retryAfter <= 0 {
		retryAfter = rl.refill
	}
	return false, retryAfter
}

var (
	certificateLimiter = newRateLimiter(10, time.Minute)
	collectionLimiter  = newRateLimiter(30, time.Minute)
	getLimiter         = newRateLimiter(60, time.Minute)
)

func clientIP(c *gin.Context) string {
	if fwd := c.GetHeader("X-Forwarded-For"); fwd != "" {
		return fwd
	}
	return c.ClientIP()
}

func RateLimitCertificate() gin.HandlerFunc {
	return func(c *gin.Context) {
		allowed, retryAfter := certificateLimiter.allow(clientIP(c))
		if !allowed {
			c.Header("Retry-After", fmt.Sprintf("%.0f", retryAfter.Seconds()))
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "rate limit exceeded, retry later"})
			return
		}
		c.Next()
	}
}

func RateLimitCollection() gin.HandlerFunc {
	return func(c *gin.Context) {
		allowed, retryAfter := collectionLimiter.allow(clientIP(c))
		if !allowed {
			c.Header("Retry-After", fmt.Sprintf("%.0f", retryAfter.Seconds()))
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "rate limit exceeded, retry later"})
			return
		}
		c.Next()
	}
}

func RateLimitGet() gin.HandlerFunc {
	return func(c *gin.Context) {
		allowed, retryAfter := getLimiter.allow(clientIP(c))
		if !allowed {
			c.Header("Retry-After", fmt.Sprintf("%.0f", retryAfter.Seconds()))
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "rate limit exceeded, retry later"})
			return
		}
		c.Next()
	}
}
