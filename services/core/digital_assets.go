package main

import (
	"database/sql"
	"errors"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	digitalAssetItemPathPrefix = "/api/v1/admin/digital-assets/"
	digitalAssetMaxPriceCents  = int64(999999999999)
)

var errInvalidDigitalAssetPrice = errors.New("invalid digital asset renewal price")

type digitalAssetPrice int64

func (price *digitalAssetPrice) UnmarshalJSON(data []byte) error {
	raw := strings.TrimSpace(string(data))
	if raw == "" || raw == "null" || len(raw) > 64 {
		return errInvalidDigitalAssetPrice
	}
	value, ok := new(big.Rat).SetString(raw)
	if !ok || value.Sign() < 0 || value.Cmp(big.NewRat(digitalAssetMaxPriceCents, 100)) > 0 {
		return errInvalidDigitalAssetPrice
	}
	scaled := new(big.Rat).Mul(value, big.NewRat(100, 1))
	if scaled.Denom().Cmp(big.NewInt(1)) != 0 || !scaled.Num().IsInt64() {
		return errInvalidDigitalAssetPrice
	}
	cents := scaled.Num().Int64()
	if cents < 0 || cents > digitalAssetMaxPriceCents {
		return errInvalidDigitalAssetPrice
	}
	*price = digitalAssetPrice(cents)
	return nil
}

func (price digitalAssetPrice) MarshalJSON() ([]byte, error) {
	cents := int64(price)
	if cents < 0 || cents > digitalAssetMaxPriceCents {
		return nil, errInvalidDigitalAssetPrice
	}
	whole := strconv.FormatInt(cents/100, 10)
	fraction := strconv.FormatInt(cents%100, 10)
	if len(fraction) == 1 {
		fraction = "0" + fraction
	}
	return []byte(whole + "." + fraction), nil
}

type digitalAssetRecord struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	StartDate    string            `json:"startDate"`
	EndDate      string            `json:"endDate"`
	RenewalPrice digitalAssetPrice `json:"renewalPrice"`
	RenewalURL   string            `json:"renewalUrl"`
	CreatedAt    time.Time         `json:"createdAt"`
	UpdatedAt    time.Time         `json:"updatedAt"`
}

type digitalAssetInput struct {
	Name         string             `json:"name"`
	StartDate    string             `json:"startDate"`
	EndDate      string             `json:"endDate"`
	RenewalPrice *digitalAssetPrice `json:"renewalPrice"`
	RenewalURL   string             `json:"renewalUrl"`
}

func (input *digitalAssetInput) normalizeAndValidate() error {
	input.Name = strings.TrimSpace(input.Name)
	if !utf8.ValidString(input.Name) || utf8.RuneCountInString(input.Name) < 1 || utf8.RuneCountInString(input.Name) > 160 {
		return errors.New("invalid digital asset name")
	}
	startDate, err := strictDigitalAssetDate(input.StartDate)
	if err != nil {
		return err
	}
	endDate, err := strictDigitalAssetDate(input.EndDate)
	if err != nil || endDate.Before(startDate) {
		return errors.New("invalid digital asset date range")
	}
	if input.RenewalPrice == nil || int64(*input.RenewalPrice) < 0 || int64(*input.RenewalPrice) > digitalAssetMaxPriceCents {
		return errInvalidDigitalAssetPrice
	}
	input.RenewalURL = strings.TrimSpace(input.RenewalURL)
	if !utf8.ValidString(input.RenewalURL) || utf8.RuneCountInString(input.RenewalURL) < 1 || utf8.RuneCountInString(input.RenewalURL) > 2048 {
		return errors.New("invalid digital asset renewal URL")
	}
	parsedURL, err := url.ParseRequestURI(input.RenewalURL)
	if err != nil || (!strings.EqualFold(parsedURL.Scheme, "http") && !strings.EqualFold(parsedURL.Scheme, "https")) || parsedURL.Hostname() == "" {
		return errors.New("invalid digital asset renewal URL")
	}
	return nil
}

func strictDigitalAssetDate(value string) (time.Time, error) {
	const layout = "2006-01-02"
	if len(value) != len(layout) || strings.TrimSpace(value) != value {
		return time.Time{}, errors.New("invalid digital asset date")
	}
	parsed, err := time.Parse(layout, value)
	if err != nil || parsed.Format(layout) != value {
		return time.Time{}, errors.New("invalid digital asset date")
	}
	return parsed, nil
}

type digitalAssetScanner interface {
	Scan(dest ...any) error
}

func scanDigitalAsset(scanner digitalAssetScanner) (digitalAssetRecord, error) {
	var asset digitalAssetRecord
	var priceCents int64
	err := scanner.Scan(
		&asset.ID,
		&asset.Name,
		&asset.StartDate,
		&asset.EndDate,
		&priceCents,
		&asset.RenewalURL,
		&asset.CreatedAt,
		&asset.UpdatedAt,
	)
	asset.RenewalPrice = digitalAssetPrice(priceCents)
	return asset, err
}

func (srv *Server) digitalAssets(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		srv.listDigitalAssets(w, r)
	case http.MethodPost:
		srv.createDigitalAsset(w, r)
	default:
		problem(w, http.StatusMethodNotAllowed, "方法不允许")
	}
}

func (srv *Server) digitalAsset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch && r.Method != http.MethodDelete {
		problem(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	assetID, ok := digitalAssetIDFromPath(r.URL.Path)
	if !ok {
		problem(w, http.StatusNotFound, "数字资产不存在")
		return
	}
	if r.Method == http.MethodPatch {
		srv.updateDigitalAsset(w, r, assetID)
		return
	}
	srv.deleteDigitalAsset(w, r, assetID)
}

func digitalAssetIDFromPath(requestPath string) (string, bool) {
	if !strings.HasPrefix(requestPath, digitalAssetItemPathPrefix) {
		return "", false
	}
	assetID := strings.TrimPrefix(requestPath, digitalAssetItemPathPrefix)
	if assetID == "" || assetID != strings.TrimSpace(assetID) || strings.Contains(assetID, "/") || !validImportUUID(assetID) {
		return "", false
	}
	return assetID, true
}

func (srv *Server) listDigitalAssets(w http.ResponseWriter, r *http.Request) {
	if !srv.requirePersistent(w) {
		return
	}
	ownerID, ok := srv.digitalAssetOwnerID(w, r)
	if !ok {
		return
	}
	rows, err := srv.store.database.QueryContext(r.Context(), `SELECT id::text,name,start_date::text,end_date::text,(renewal_price * 100)::bigint,renewal_url,created_at,updated_at
		FROM digital_assets
		WHERE owner_id=$1::uuid
		ORDER BY end_date ASC,name ASC,id ASC`, ownerID)
	if err != nil {
		digitalAssetDatabaseUnavailable(w)
		return
	}
	defer rows.Close()
	assets := make([]digitalAssetRecord, 0)
	for rows.Next() {
		asset, scanErr := scanDigitalAsset(rows)
		if scanErr != nil {
			digitalAssetDatabaseUnavailable(w)
			return
		}
		assets = append(assets, asset)
	}
	if err := rows.Err(); err != nil {
		digitalAssetDatabaseUnavailable(w)
		return
	}
	jsonResponse(w, http.StatusOK, map[string]any{"digitalAssets": assets})
}

func (srv *Server) createDigitalAsset(w http.ResponseWriter, r *http.Request) {
	var input digitalAssetInput
	if decodeStrictJSON(r, &input) != nil || input.normalizeAndValidate() != nil {
		problem(w, http.StatusBadRequest, "数字资产信息无效")
		return
	}
	if !srv.requirePersistent(w) {
		return
	}
	ownerID, ok := srv.digitalAssetOwnerID(w, r)
	if !ok {
		return
	}
	asset, err := scanDigitalAsset(srv.store.database.QueryRowContext(r.Context(), `INSERT INTO digital_assets(owner_id,name,start_date,end_date,renewal_price,renewal_url)
		VALUES($1::uuid,$2,$3::date,$4::date,($5::numeric / 100)::numeric(12,2),$6)
		RETURNING id::text,name,start_date::text,end_date::text,(renewal_price * 100)::bigint,renewal_url,created_at,updated_at`,
		ownerID, input.Name, input.StartDate, input.EndDate, int64(*input.RenewalPrice), input.RenewalURL))
	if err != nil {
		digitalAssetDatabaseUnavailable(w)
		return
	}
	jsonResponse(w, http.StatusCreated, asset)
}

func (srv *Server) updateDigitalAsset(w http.ResponseWriter, r *http.Request, assetID string) {
	var input digitalAssetInput
	if decodeStrictJSON(r, &input) != nil || input.normalizeAndValidate() != nil {
		problem(w, http.StatusBadRequest, "数字资产信息无效")
		return
	}
	if !srv.requirePersistent(w) {
		return
	}
	ownerID, ok := srv.digitalAssetOwnerID(w, r)
	if !ok {
		return
	}
	asset, err := scanDigitalAsset(srv.store.database.QueryRowContext(r.Context(), `UPDATE digital_assets
		SET name=$3,start_date=$4::date,end_date=$5::date,renewal_price=($6::numeric / 100)::numeric(12,2),renewal_url=$7,updated_at=now()
		WHERE id=$1::uuid AND owner_id=$2::uuid
		RETURNING id::text,name,start_date::text,end_date::text,(renewal_price * 100)::bigint,renewal_url,created_at,updated_at`,
		assetID, ownerID, input.Name, input.StartDate, input.EndDate, int64(*input.RenewalPrice), input.RenewalURL))
	if errors.Is(err, sql.ErrNoRows) {
		problem(w, http.StatusNotFound, "数字资产不存在")
		return
	}
	if err != nil {
		digitalAssetDatabaseUnavailable(w)
		return
	}
	jsonResponse(w, http.StatusOK, asset)
}

func (srv *Server) deleteDigitalAsset(w http.ResponseWriter, r *http.Request, assetID string) {
	if !srv.requirePersistent(w) {
		return
	}
	ownerID, ok := srv.digitalAssetOwnerID(w, r)
	if !ok {
		return
	}
	result, err := srv.store.database.ExecContext(r.Context(), `DELETE FROM digital_assets WHERE id=$1::uuid AND owner_id=$2::uuid`, assetID, ownerID)
	if err != nil {
		digitalAssetDatabaseUnavailable(w)
		return
	}
	deleted, err := result.RowsAffected()
	if err != nil {
		digitalAssetDatabaseUnavailable(w)
		return
	}
	if deleted == 0 {
		problem(w, http.StatusNotFound, "数字资产不存在")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (srv *Server) digitalAssetOwnerID(w http.ResponseWriter, r *http.Request) (string, bool) {
	ownerID, err := srv.persistentUserID(r)
	if err != nil {
		digitalAssetDatabaseUnavailable(w)
		return "", false
	}
	return ownerID, true
}

func digitalAssetDatabaseUnavailable(w http.ResponseWriter) {
	problem(w, http.StatusServiceUnavailable, "数据库不可用")
}
