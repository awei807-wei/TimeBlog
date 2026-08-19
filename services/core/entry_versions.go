package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

func (srv *Server) entryVersionsDatabase(w http.ResponseWriter, r *http.Request, ownerID, entryID string, suffix []string) {
	if len(suffix) == 0 && r.Method == http.MethodGet {
		rows, err := srv.store.database.QueryContext(r.Context(), `SELECT v.version_no,v.created_at,v.snapshot FROM entry_versions v JOIN entries e ON e.id=v.entry_id WHERE v.entry_id=$1::uuid AND e.author_id=$2::uuid ORDER BY v.version_no DESC LIMIT 20`, entryID, ownerID)
		if err != nil {
			problem(w, 500, "读取版本失败")
			return
		}
		defer rows.Close()
		versions := []map[string]any{}
		for rows.Next() {
			var version int
			var created time.Time
			var snapshot []byte
			if err := rows.Scan(&version, &created, &snapshot); err != nil {
				problem(w, 500, "读取版本失败")
				return
			}
			var data map[string]any
			_ = json.Unmarshal(snapshot, &data)
			versions = append(versions, map[string]any{"version": version, "createdAt": created, "snapshot": data})
		}
		jsonResponse(w, http.StatusOK, map[string]any{"versions": versions})
		return
	}
	if len(suffix) == 2 && suffix[1] == "restore" && r.Method == http.MethodPost {
		version, err := strconv.Atoi(suffix[0])
		if err != nil || version < 1 {
			problem(w, 400, "版本号无效")
			return
		}
		var snapshot []byte
		if err := srv.store.database.QueryRowContext(r.Context(), `SELECT v.snapshot FROM entry_versions v JOIN entries e ON e.id=v.entry_id WHERE v.entry_id=$1::uuid AND e.author_id=$2::uuid AND v.version_no=$3`, entryID, ownerID, version).Scan(&snapshot); err != nil {
			problem(w, 404, "版本不存在")
			return
		}
		var data struct {
			Title    string `json:"title"`
			Summary  string `json:"summary"`
			Markdown string `json:"markdown"`
			Slug     string `json:"slug"`
		}
		if json.Unmarshal(snapshot, &data) != nil {
			problem(w, 500, "版本数据无效")
			return
		}
		htmlOut, plain := renderMarkdown(data.Markdown)
		res, err := srv.store.database.ExecContext(r.Context(), `UPDATE entries SET title=$1,summary=$2,markdown=$3,rendered_html=$4,plain_text=$5,slug=$6,revision=revision+1,updated_at=now() WHERE id=$7::uuid AND author_id=$8::uuid`, data.Title, data.Summary, data.Markdown, htmlOut, plain, data.Slug, entryID, ownerID)
		if err != nil {
			problem(w, 500, "恢复版本失败")
			return
		}
		if n, _ := res.RowsAffected(); n != 1 {
			problem(w, 404, "内容不存在")
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"entryId": entryID, "restoredVersion": version})
		return
	}
	problem(w, http.StatusMethodNotAllowed, "方法不允许")
}
