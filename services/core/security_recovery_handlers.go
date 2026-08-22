package main

import (
	"errors"
	"net/http"
	"strings"
	"time"
)

func (srv *Server) startTOTPPasswordRecovery(w http.ResponseWriter, r *http.Request) {
	setRecoveryNoStore(w)
	if r.Method != http.MethodPost {
		problem(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	if !srv.recoveryOriginAllowed(r) || !jsonContentType(r) {
		problem(w, http.StatusForbidden, "请求来源或格式不被允许")
		return
	}
	var in totpPasswordResetStartRequest
	if decodeStrictJSON(r, &in) != nil {
		srv.throttleFailure(r, "owner-recovery")
		problem(w, http.StatusBadRequest, "恢复请求无效")
		return
	}
	if !srv.throttleAllows(r, "owner-recovery") {
		w.Header().Set("Retry-After", "30")
		problem(w, http.StatusTooManyRequests, "尝试次数过多，请稍后重试")
		return
	}
	challenge, err := generatePasswordResetChallenge()
	if err != nil {
		problem(w, http.StatusInternalServerError, "恢复请求失败")
		return
	}
	expiresAt := time.Now().Add(5 * time.Minute)
	if srv.store.persistent && srv.store.database != nil {
		if _, err = srv.store.database.ExecContext(r.Context(), `DELETE FROM mfa_challenges WHERE purpose=$1 AND expires_at<=now()`, passwordResetChallengePurpose); err == nil {
			err = persistPasswordResetChallenge(r.Context(), srv.store.database, challenge, expiresAt)
		}
	} else {
		srv.store.mu.Lock()
		for token, current := range srv.store.mfaChallenges {
			if current.Purpose == passwordResetChallengePurpose && !current.ExpiresAt.After(time.Now()) {
				delete(srv.store.mfaChallenges, token)
			}
		}
		challengeHash := tokenHash(challenge)
		srv.store.mfaChallenges[challengeHash] = memoryMFAChallenge{ChallengeHash: challengeHash, ExpiresAt: expiresAt, Purpose: passwordResetChallengePurpose}
		srv.store.mu.Unlock()
	}
	if err != nil {
		srv.throttleFailure(r, "owner-recovery")
		problem(w, http.StatusInternalServerError, "恢复请求失败")
		return
	}
	// Challenge issuance itself is rate-limited. A successful completion clears
	// this bucket; uncompleted challenge spam therefore cannot be unbounded.
	srv.throttleFailure(r, "owner-recovery")
	jsonResponse(w, http.StatusOK, map[string]any{"challenge": challenge, "expiresAt": expiresAt.UTC()})
}

func (srv *Server) completeTOTPPasswordRecovery(w http.ResponseWriter, r *http.Request) {
	setRecoveryNoStore(w)
	if r.Method != http.MethodPost {
		problem(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	if !srv.recoveryOriginAllowed(r) || !jsonContentType(r) {
		problem(w, http.StatusForbidden, "请求来源或格式不被允许")
		return
	}
	if !srv.throttleAllows(r, "owner-recovery") {
		w.Header().Set("Retry-After", "30")
		problem(w, http.StatusTooManyRequests, "尝试次数过多，请稍后重试")
		return
	}
	var in totpPasswordResetCompleteRequest
	if decodeStrictJSON(r, &in) != nil || in.normalizeAndValidate() != nil {
		srv.throttleFailure(r, "owner-recovery")
		srv.recordRecoveryAudit(r, "", false, "totp_password_reset_invalid_request")
		problem(w, http.StatusBadRequest, "恢复请求无效")
		return
	}
	key, err := srv.accountRecoveryMACKey()
	if err != nil {
		problem(w, http.StatusInternalServerError, "恢复失败")
		return
	}
	payloadMAC := operationPayloadMAC(key, totpOperationPurpose, in.Challenge, in.Code, in.NewPassword, in.OperationToken)
	operationHash := namespacedOperationHash(totpOperationPurpose, in.OperationToken)
	if srv.store.persistent && srv.store.database != nil {
		err = srv.completeTOTPPasswordRecoveryPersistent(r, in, operationHash, payloadMAC)
	} else {
		err = srv.completeTOTPPasswordRecoveryMemory(r, in, operationHash, payloadMAC)
	}
	if err != nil {
		srv.throttleFailure(r, "owner-recovery")
		srv.recordRecoveryAudit(r, "", false, "totp_password_reset_failed")
		switch {
		case errors.Is(err, errAuthOperationConflict):
			problem(w, http.StatusConflict, "恢复操作已被其他请求占用或替代")
		case errors.Is(err, errInvalidPasswordReset):
			problem(w, http.StatusUnauthorized, "恢复信息无效")
		case errors.Is(err, errPasswordResetReplay):
			problem(w, http.StatusUnauthorized, "验证码已使用，请重新获取验证码")
		default:
			problem(w, http.StatusInternalServerError, "恢复失败")
		}
		return
	}
	srv.throttleSuccess(r, "owner-recovery")
	jsonResponse(w, http.StatusOK, map[string]bool{"ok": true})
}

func (srv *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	setRecoveryNoStore(w)
	if r.Method != http.MethodPost {
		problem(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	if !srv.recoveryOriginAllowed(r) || !jsonContentType(r) {
		problem(w, http.StatusForbidden, "请求来源或格式不被允许")
		return
	}
	if !srv.throttleAllows(r, "owner-recovery") {
		w.Header().Set("Retry-After", "30")
		problem(w, http.StatusTooManyRequests, "尝试次数过多，请稍后重试")
		return
	}
	if !srv.checkMutation(w, r) {
		return
	}
	var in passwordChangeRequest
	if decodeStrictJSON(r, &in) != nil || in.normalizeAndValidate() != nil {
		srv.throttleFailure(r, "owner-recovery")
		problem(w, http.StatusBadRequest, "改密请求无效")
		return
	}
	var err error
	if srv.store.persistent && srv.store.database != nil {
		err = srv.changePasswordPersistent(r, in)
	} else {
		err = srv.changePasswordMemory(r, in)
	}
	if err != nil {
		srv.throttleFailure(r, "owner-recovery")
		srv.recordRecoveryAudit(r, "", false, "password_change_failed")
		if errors.Is(err, errInvalidSecurityFactors) || errors.Is(err, errPasswordResetReplay) {
			problem(w, http.StatusUnauthorized, "当前凭据无效")
		} else {
			problem(w, http.StatusInternalServerError, "改密失败")
		}
		return
	}
	srv.throttleSuccess(r, "owner-recovery")
	clearTimelineSessionCookie(w)
	jsonResponse(w, http.StatusOK, map[string]bool{"ok": true})
}

func (srv *Server) rotateRecoveryKey(w http.ResponseWriter, r *http.Request) {
	setRecoveryNoStore(w)
	if r.Method != http.MethodPost {
		problem(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	if !srv.recoveryOriginAllowed(r) || !jsonContentType(r) {
		problem(w, http.StatusForbidden, "请求来源或格式不被允许")
		return
	}
	if !srv.throttleAllows(r, "owner-recovery") {
		w.Header().Set("Retry-After", "30")
		problem(w, http.StatusTooManyRequests, "尝试次数过多，请稍后重试")
		return
	}
	if !srv.checkMutation(w, r) {
		return
	}
	var in recoveryKeyRotationRequest
	if decodeStrictJSON(r, &in) != nil || in.normalizeAndValidate() != nil {
		srv.throttleFailure(r, "owner-recovery")
		problem(w, http.StatusBadRequest, "恢复密钥轮换请求无效")
		return
	}
	key, err := srv.accountRecoveryMACKey()
	if err != nil {
		problem(w, http.StatusInternalServerError, "恢复密钥轮换失败")
		return
	}
	payloadMAC := operationPayloadMAC(key, recoveryRotationPurpose, in.Password, in.Code, in.OperationToken, in.NewRecoveryKey)
	operationHash := namespacedOperationHash(recoveryRotationPurpose, in.OperationToken)
	if srv.store.persistent && srv.store.database != nil {
		err = srv.rotateRecoveryKeyPersistent(r, in, operationHash, payloadMAC)
	} else {
		err = srv.rotateRecoveryKeyMemory(r, in, operationHash, payloadMAC)
	}
	if err != nil {
		srv.throttleFailure(r, "owner-recovery")
		srv.recordRecoveryAudit(r, "", false, "recovery_key_rotation_failed")
		switch {
		case errors.Is(err, errAuthOperationConflict):
			problem(w, http.StatusConflict, "恢复密钥轮换操作已被其他请求占用或替代")
		case errors.Is(err, errInvalidRecoveryRotate), errors.Is(err, errInvalidSecurityFactors), errors.Is(err, errPasswordResetReplay):
			problem(w, http.StatusUnauthorized, "当前凭据或恢复密钥无效")
		default:
			problem(w, http.StatusInternalServerError, "恢复密钥轮换失败")
		}
		return
	}
	srv.throttleSuccess(r, "owner-recovery")
	jsonResponse(w, http.StatusOK, map[string]any{"ok": true, "recoveryKey": in.NewRecoveryKey})
}

func jsonContentType(r *http.Request) bool {
	contentType := strings.TrimSpace(strings.SplitN(r.Header.Get("Content-Type"), ";", 2)[0])
	return strings.EqualFold(contentType, "application/json")
}

func clearTimelineSessionCookie(w http.ResponseWriter) {
	secure := getenv("APP_ENV", "") == "production"
	http.SetCookie(w, &http.Cookie{Name: "timeline_session", MaxAge: -1, Path: "/", HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode})
}
