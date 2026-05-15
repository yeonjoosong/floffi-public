package server

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

// Attachment limits. Tuned so agents can ingest reasonably-sized documents
// (manuals, log slices, CSVs) without letting users blow up the LLM context
// or fill the disk.
const (
	maxAttachmentBytes      = 4 * 1024 * 1024  // 4 MiB per file (upload cap)
	maxAttachmentsPerTask   = 8                // hard cap so the prompt stays bounded
	maxInlinePromptBytes    = 64 * 1024        // 64 KiB per file inlined into the prompt
	maxTotalInlinePromptKiB = 256 * 1024       // 256 KiB combined inline cap across all files
	multipartMaxMemory      = 16 * 1024 * 1024 // 16 MiB before spilling to disk
)

// attachmentsRoot returns the on-disk directory for THIS workspace's
// uploaded files. Phase 11 introduced per-workspace scoping:
//   pre-Phase-11: .data/attachments/<taskID>/
//   post-Phase-11: .data/attachments/<workspaceID>/<taskID>/
// Legacy stores without a workspaceID fall back to the old layout —
// only test fixtures and the one-shot legacy migration build that
// state today.
func (s *workspaceStore) attachmentsRoot() string {
	if s.workspaceID == "" {
		return filepath.Join(".data", "attachments")
	}
	return filepath.Join(".data", "attachments", s.workspaceID)
}

func (s *workspaceStore) attachmentDir(taskID string) string {
	return filepath.Join(s.attachmentsRoot(), taskID)
}

// addAttachment registers an already-saved file with a task. Returns the
// attachment metadata that was appended.
func (s *workspaceStore) addAttachment(taskID string, a workspaceAttachment) (workspaceAttachment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i, t := range s.state.Tasks {
		if t.ID != taskID {
			continue
		}
		if len(t.Attachments) >= maxAttachmentsPerTask {
			return workspaceAttachment{}, fmt.Errorf("attachment limit reached (%d per task)", maxAttachmentsPerTask)
		}
		s.state.Tasks[i].Attachments = append(s.state.Tasks[i].Attachments, a)
		if err := s.saveLocked(); err != nil {
			return workspaceAttachment{}, err
		}
		return a, nil
	}
	return workspaceAttachment{}, fmt.Errorf("task not found: %s", taskID)
}

// removeAttachment unregisters an attachment from a task and deletes its file.
func (s *workspaceStore) removeAttachment(taskID, attachmentID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i, t := range s.state.Tasks {
		if t.ID != taskID {
			continue
		}
		for j, a := range t.Attachments {
			if a.ID != attachmentID {
				continue
			}
			diskPath := filepath.Join(s.attachmentDir(taskID), a.StoredName)
			s.state.Tasks[i].Attachments = append(t.Attachments[:j], t.Attachments[j+1:]...)
			if err := s.saveLocked(); err != nil {
				return err
			}
			// Best-effort file removal: metadata is the source of truth, so
			// leftover bytes on a failed unlink are a cleanup issue, not a bug.
			_ = os.Remove(diskPath)
			return nil
		}
		return fmt.Errorf("attachment not found: %s", attachmentID)
	}
	return fmt.Errorf("task not found: %s", taskID)
}

// findAttachment is a read-only lookup used by the download handler and the
// prompt builder.
func (s *workspaceStore) findAttachment(taskID, attachmentID string) (workspaceAttachment, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, t := range s.state.Tasks {
		if t.ID != taskID {
			continue
		}
		for _, a := range t.Attachments {
			if a.ID == attachmentID {
				return a, true
			}
		}
		return workspaceAttachment{}, false
	}
	return workspaceAttachment{}, false
}

// sweepOrphanAttachments removes any attachments/{taskID}/ directory whose
// taskID is no longer present in the workspace state. Called once at boot
// after normalize() has had a chance to purge expired trash. Best-effort:
// errors are logged but never block startup.
func (s *workspaceStore) sweepOrphanAttachments() {
	root := s.attachmentsRoot()
	entries, err := os.ReadDir(root)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			logger.Error("attachments sweep: cannot read dir", "path", root, "err", err)
		}
		return
	}

	s.mu.RLock()
	live := make(map[string]struct{}, len(s.state.Tasks))
	for _, t := range s.state.Tasks {
		live[t.ID] = struct{}{}
	}
	s.mu.RUnlock()

	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if _, ok := live[e.Name()]; ok {
			continue
		}
		path := filepath.Join(root, e.Name())
		if err := os.RemoveAll(path); err != nil {
			logger.Error("attachments sweep: failed to remove orphan dir", "path", path, "err", err)
			continue
		}
		logger.Info("attachments sweep: removed orphan dir", "path", path)
	}
}

// sanitizeAttachmentName strips path separators and keeps the result short so
// it's safe to use as part of an on-disk filename. The user-visible original
// name is preserved separately in workspaceAttachment.Name.
func sanitizeAttachmentName(name string) string {
	name = filepath.Base(name)
	name = strings.ReplaceAll(name, "\x00", "")
	// Keep only chars that survive on every common FS without escaping.
	var b strings.Builder
	for _, r := range name {
		switch {
		case r == '.' || r == '-' || r == '_':
			b.WriteRune(r)
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	out := b.String()
	if out == "" {
		out = "file"
	}
	if len(out) > 80 {
		out = out[:80]
	}
	return out
}

func newAttachmentID() string {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("att-%d", time.Now().UnixNano())
	}
	return "att-" + hex.EncodeToString(buf[:])
}

// saveGeneratedImage persists model-generated image bytes as a new attachment
// on the task. Filename is timestamped so multiple regenerations don't clash,
// and we infer the extension from the MIME so the browser previews it
// correctly without sniffing.
func (s *workspaceStore) saveGeneratedImage(taskID, mime string, data []byte) (workspaceAttachment, error) {
	ext := ".png"
	switch strings.ToLower(mime) {
	case "image/jpeg", "image/jpg":
		ext = ".jpg"
	case "image/webp":
		ext = ".webp"
	}
	dir := s.attachmentDir(taskID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return workspaceAttachment{}, err
	}
	attID := newAttachmentID()
	storedName := fmt.Sprintf("%s__generated-%s%s", attID, time.Now().UTC().Format("20060102-150405"), ext)
	dst := filepath.Join(dir, storedName)
	if err := os.WriteFile(dst, data, 0o644); err != nil {
		return workspaceAttachment{}, err
	}
	att := workspaceAttachment{
		ID:         attID,
		Name:       fmt.Sprintf("generated-%s%s", time.Now().UTC().Format("20060102-150405"), ext),
		Size:       int64(len(data)),
		MIME:       mime,
		StoredName: storedName,
		UploadedAt: time.Now().UTC().Format(time.RFC3339),
	}
	saved, err := s.addAttachment(taskID, att)
	if err != nil {
		_ = os.Remove(dst)
		return workspaceAttachment{}, err
	}
	return saved, nil
}

// saveUploadedFile writes the multipart file part to disk under the task's
// attachment directory, enforcing the per-file size cap. Returns the stored
// filename (relative to attachmentDir) and the byte count actually written.
func (s *workspaceStore) saveUploadedFile(taskID string, hdr *multipart.FileHeader, file multipart.File) (storedName string, written int64, err error) {
	dir := s.attachmentDir(taskID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", 0, err
	}

	storedName = newAttachmentID() + "__" + sanitizeAttachmentName(hdr.Filename)
	dst := filepath.Join(dir, storedName)

	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return "", 0, err
	}
	defer out.Close()

	// LimitReader returns EOF at the cap. If the next byte still exists in the
	// underlying reader, we know the upload exceeded the limit.
	limited := io.LimitReader(file, maxAttachmentBytes+1)
	n, err := io.Copy(out, limited)
	if err != nil {
		_ = os.Remove(dst)
		return "", 0, err
	}
	if n > maxAttachmentBytes {
		_ = os.Remove(dst)
		return "", 0, fmt.Errorf("file exceeds %d byte limit", maxAttachmentBytes)
	}
	return storedName, n, nil
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

// handleTaskAttachments routes /api/tasks/{id}/attachments and
// /api/tasks/{id}/attachments/{attachmentId}. The router resolves the
// active workspace once and threads the store into each sub-handler,
// so attachment paths land in the right per-workspace directory.
func (s *Server) handleTaskAttachments(w http.ResponseWriter, r *http.Request) {
	wsCtx := s.resolveActiveWorkspace(w, r)
	if wsCtx == nil {
		return
	}

	// Path: /api/tasks/{id}/attachments[/{attachmentId}]
	rest := strings.TrimPrefix(r.URL.Path, "/api/tasks/")
	// rest is "{id}/attachments" or "{id}/attachments/{attachmentId}"
	parts := strings.SplitN(rest, "/", 3)
	if len(parts) < 2 || parts[1] != "attachments" {
		http.NotFound(w, r)
		return
	}
	taskID := parts[0]
	if taskID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid task path"})
		return
	}

	if len(parts) == 2 {
		// /api/tasks/{id}/attachments — POST upload
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		s.handleAttachmentUpload(w, r, wsCtx.store, taskID)
		return
	}

	// /api/tasks/{id}/attachments/{attachmentId} — GET or DELETE
	attachmentID := parts[2]
	if attachmentID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid attachment id"})
		return
	}
	switch r.Method {
	case http.MethodGet:
		s.handleAttachmentDownload(w, r, wsCtx.store, taskID, attachmentID)
	case http.MethodDelete:
		s.handleAttachmentDelete(w, r, wsCtx.store, taskID, attachmentID)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleAttachmentUpload(w http.ResponseWriter, r *http.Request, store *workspaceStore, taskID string) {
	// Verify the task exists before parsing the (potentially large) body.
	state := store.snapshot()
	taskExists := false
	for _, t := range state.Tasks {
		if t.ID == taskID {
			taskExists = true
			break
		}
	}
	if !taskExists {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "task not found"})
		return
	}

	// Cap the entire request body so a malicious client can't hold the server
	// open by streaming forever. Some headroom over the per-file cap covers
	// multipart envelope overhead.
	r.Body = http.MaxBytesReader(w, r.Body, maxAttachmentBytes+1<<20)
	if err := r.ParseMultipartForm(multipartMaxMemory); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid multipart: " + err.Error()})
		return
	}

	form := r.MultipartForm
	if form == nil || len(form.File["file"]) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing file field"})
		return
	}

	hdr := form.File["file"][0]
	file, err := hdr.Open()
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "cannot open uploaded file"})
		return
	}
	defer file.Close()

	storedName, size, err := store.saveUploadedFile(taskID, hdr, file)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}

	mime := hdr.Header.Get("Content-Type")
	if mime == "" {
		mime = "application/octet-stream"
	}

	// The stored filename starts with "att-<hex>__"; reuse that as the
	// attachment ID so download/delete URLs are stable and meaningful.
	attID := strings.SplitN(storedName, "__", 2)[0]
	att := workspaceAttachment{
		ID:         attID,
		Name:       filepath.Base(hdr.Filename),
		Size:       size,
		MIME:       mime,
		StoredName: storedName,
		UploadedAt: time.Now().UTC().Format(time.RFC3339),
	}

	saved, err := store.addAttachment(taskID, att)
	if err != nil {
		// Roll back the file write if metadata registration failed (e.g. quota).
		_ = os.Remove(filepath.Join(store.attachmentDir(taskID), storedName))
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, saved)
}

func (s *Server) handleAttachmentDownload(w http.ResponseWriter, _ *http.Request, store *workspaceStore, taskID, attachmentID string) {
	att, ok := store.findAttachment(taskID, attachmentID)
	if !ok {
		http.NotFound(w, nil)
		return
	}
	path := filepath.Join(store.attachmentDir(taskID), att.StoredName)
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.NotFound(w, nil)
			return
		}
		http.Error(w, "read failed", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	w.Header().Set("Content-Type", att.MIME)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", att.Name))
	if att.Size > 0 {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", att.Size))
	}
	_, _ = io.Copy(w, f)
}

func (s *Server) handleAttachmentDelete(w http.ResponseWriter, _ *http.Request, store *workspaceStore, taskID, attachmentID string) {
	if err := store.removeAttachment(taskID, attachmentID); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── Prompt-side helpers ───────────────────────────────────────────────────────

// ImagePart bundles raw bytes + MIME for a single attachment that should be
// sent to a vision-capable model as inline_data. Order matches task.Attachments
// so prompt references like "1번째 이미지" stay meaningful.
type ImagePart struct {
	MIME string
	Data []byte
	Name string
}

// supportedImageMIME is the whitelist for what we actually pass through to the
// Gemini vision endpoint. We exclude heic/heif for now even though Gemini
// supports them — most users send png/jpeg/webp and adding heic only widens
// the attack surface (corrupt-file parsing) without a real use case.
var supportedImageMIME = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/jpg":  true,
	"image/webp": true,
}

// maxTotalInlineImageBytes caps the combined size of images we'll send in a
// single request. Gemini's inline_data ceiling is ~20MB total; 18MB leaves
// room for the JSON envelope and the text prompt itself.
const maxTotalInlineImageBytes = 18 * 1024 * 1024

// collectImagePartsForPrompt reads every image attachment on the task from
// disk and returns the bytes alongside MIME, dropping anything that exceeds
// the combined size cap. The boolean truncated flag signals whether at least
// one image was skipped — the caller can mention this in the prompt so the
// model knows it didn't see everything.
func (s *workspaceStore) collectImagePartsForPrompt(taskID string, atts []workspaceAttachment) (parts []ImagePart, truncated bool) {
	total := 0
	for _, att := range atts {
		if !supportedImageMIME[strings.ToLower(att.MIME)] {
			continue
		}
		path := filepath.Join(s.attachmentDir(taskID), att.StoredName)
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if total+len(data) > maxTotalInlineImageBytes {
			truncated = true
			continue
		}
		total += len(data)
		parts = append(parts, ImagePart{
			MIME: strings.ToLower(att.MIME),
			Data: data,
			Name: att.Name,
		})
	}
	return parts, truncated
}

// readAttachmentForPrompt reads up to maxInlinePromptBytes of an attachment
// and returns it as a string, but only if the content is valid UTF-8 (i.e.
// not a binary blob like a PDF or zip). The boolean indicates whether the
// text is suitable for inlining.
func (s *workspaceStore) readAttachmentForPrompt(taskID string, att workspaceAttachment) (text string, truncated, isText bool) {
	path := filepath.Join(s.attachmentDir(taskID), att.StoredName)
	f, err := os.Open(path)
	if err != nil {
		return "", false, false
	}
	defer f.Close()

	buf := make([]byte, maxInlinePromptBytes+1)
	n, _ := io.ReadFull(f, buf)
	if n <= 0 {
		return "", false, false
	}
	truncated = n > maxInlinePromptBytes
	if truncated {
		n = maxInlinePromptBytes
	}
	data := buf[:n]
	if !utf8.Valid(data) {
		return "", truncated, false
	}
	return string(data), truncated, true
}
