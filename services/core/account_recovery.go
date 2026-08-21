package main

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"time"
)

func (srv *Server) recoverAccount(w http.ResponseWriter, r *http.Request) {
	setRecoveryNoStore(w)
	if r.Method != http.MethodPost {
		problem(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	if !srv.recoveryOriginAllowed(r) {
		problem(w, http.StatusForbidden, "来源不被允许")
		return
	}
	if !srv.throttleAllows(r, "owner-recovery") {
		w.Header().Set("Retry-After", "30")
		problem(w, http.StatusTooManyRequests, "尝试次数过多，请稍后重试")
		return
	}

	var in accountRecoveryRequest
	if decode(r, &in) != nil || in.normalizeAndValidate() != nil {
		srv.throttleFailure(r, "owner-recovery")
		srv.recordRecoveryAudit(r, "", false, "invalid_request")
		problem(w, http.StatusBadRequest, "恢复信息无效")
		return
	}
	macKey, err := srv.accountRecoveryMACKey()
	if err != nil {
		log.Printf("account recovery MAC key unavailable: %v", err)
		problem(w, http.StatusInternalServerError, "恢复失败")
		return
	}
	payloadMAC := recoveryPayloadMAC(macKey, in)
	if srv.store.persistent && srv.store.database != nil {
		err = srv.recoverPersistentAccount(r, in, payloadMAC)
	} else {
		err = srv.recoverMemoryAccount(in, payloadMAC)
	}
	if srv.writeRecoveryError(w, r, err) {
		return
	}

	srv.throttleSuccess(r, "owner-recovery")
	result := recoveryResult(in)
	jsonResponse(w, http.StatusOK, map[string]any{
		"ok":           true,
		"recoveryKey":  result.RecoveryKey,
		"totpSetupURI": result.TOTPSetupURI,
	})
}

func (srv *Server) writeRecoveryError(w http.ResponseWriter, r *http.Request, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, errInvalidRecoveryKey):
		srv.throttleFailure(r, "owner-recovery")
		problem(w, http.StatusUnauthorized, "恢复信息无效")
	case errors.Is(err, errRecoveryOperationConflict):
		problem(w, http.StatusConflict, "恢复操作已被其他请求占用或替代")
	default:
		log.Printf("account recovery failed: %v", err)
		problem(w, http.StatusInternalServerError, "恢复失败")
	}
	return true
}

func (srv *Server) accountRecoveryMACKey() ([]byte, error) {
	if srv.store.persistent {
		key, err := secretKey()
		if err != nil {
			return nil, err
		}
		return recoveryOperationMACKey(key), nil
	}
	if len(srv.store.csrfKey) == 0 {
		return nil, fmt.Errorf("in-memory recovery MAC key is unavailable")
	}
	return recoveryOperationMACKey(srv.store.csrfKey), nil
}

func (srv *Server) recoverMemoryAccount(in accountRecoveryRequest, payloadMAC string) error {
	newRecoveryHash, err := hashPassword(in.NewRecoveryKey)
	if err != nil {
		return fmt.Errorf("hash new recovery key: %w", err)
	}
	operationHash := recoveryOperationHash(in.OperationToken)
	now := time.Now()

	srv.store.mu.Lock()
	defer srv.store.mu.Unlock()
	for hash, operation := range srv.store.recoveryOps {
		if !operation.ExpiresAt.After(now) {
			delete(srv.store.recoveryOps, hash)
		}
	}
	if operation, ok := srv.store.recoveryOps[operationHash]; ok {
		if !recoveryPayloadMACMatches(operation.PayloadMAC, payloadMAC) || operation.RecoveryKeyHash != srv.store.recoveryKeyHash {
			return errRecoveryOperationConflict
		}
		return nil
	}
	if srv.store.recoveryKeyHash == "" || srv.store.recoveryKeyUsed || !verifyPassword(in.RecoveryKey, srv.store.recoveryKeyHash) {
		return errInvalidRecoveryKey
	}

	srv.store.userPassword = in.NewPassword
	srv.store.userTOTP = in.NewTOTPSecret
	srv.store.recoveryKeyHash = newRecoveryHash
	srv.store.recoveryKeyUsed = false
	for _, session := range srv.store.sessions {
		revokedAt := now
		session.RevokedAt = &revokedAt
	}
	srv.store.recoveryOps[operationHash] = memoryRecoveryOperation{
		PayloadMAC:      payloadMAC,
		RecoveryKeyHash: newRecoveryHash,
		ExpiresAt:       now.Add(recoveryOperationTTL),
	}
	return nil
}

func setRecoveryNoStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store, max-age=0")
	w.Header().Set("CDN-Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
}

func (srv *Server) recordRecoveryAudit(r *http.Request, keyID string, success bool, event string) {
	if !srv.store.persistent || srv.store.database == nil {
		return
	}
	if _, err := srv.store.database.ExecContext(r.Context(), `INSERT INTO account_recovery_audit(key_id,account_hash,ip_hash,success,event) VALUES(NULLIF($1,'')::uuid,$2,$3,$4,$5)`, keyID, hashLoginField("owner"), hashLoginField(requestRemoteIP(r)), success, event); err != nil {
		log.Printf("recovery audit write event=%s: %v", event, err)
	}
}

func (srv *Server) recoveryOriginAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	return origin == getenv("APP_ORIGIN", "http://localhost:3000") || origin == "http://localhost:3000" || origin == "http://127.0.0.1:3000"
}
