package auth

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
)

// Memory CRUD routes (Stage 1 of plan/rag-and-memory-roadmap.md).
//
// All routes require a logged-in user. Authorization is *not* shared across
// users: the WHERE clauses in store_memories.go always include user_id, so
// even a forged memory ID can't reach another user's row.
//
// Route layout:
//
//   GET    /api/auth/memories                — list all of the caller's memories
//   POST   /api/auth/memories                — create
//   PUT    /api/auth/memories/{id}           — update content
//   DELETE /api/auth/memories/{id}           — delete
//
// Per-prompt fetch (the agent path) calls Store.ListUserMemoriesForPrompt
// directly — it doesn't hit HTTP at all.

const memoryMaxContentBytes = 2 * 1024 // 2KB per memory — keeps the prompt budget predictable

func writeMemoryError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]any{"error": code})
}

type memoryRequest struct {
	WorkspaceID string `json:"workspaceId,omitempty"`
	Content     string `json:"content"`
}

func (h *Handler) handleMemories(w http.ResponseWriter, r *http.Request) {
	user, _, err := h.Authenticate(r)
	if err != nil {
		writeMemoryError(w,http.StatusUnauthorized, "unauthorized")
		return
	}
	switch r.Method {
	case http.MethodGet:
		ms, err := h.Store.ListAllUserMemories(r.Context(), user.ID)
		if err != nil {
			writeMemoryError(w,http.StatusInternalServerError, "list_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"memories": ms})
	case http.MethodPost:
		var req memoryRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeMemoryError(w,http.StatusBadRequest, "invalid_json")
			return
		}
		content := strings.TrimSpace(req.Content)
		if content == "" {
			writeMemoryError(w,http.StatusBadRequest, "empty_content")
			return
		}
		if len(content) > memoryMaxContentBytes {
			writeMemoryError(w,http.StatusBadRequest, "content_too_long")
			return
		}
		m, err := h.Store.CreateUserMemory(r.Context(), user.ID, strings.TrimSpace(req.WorkspaceID), content)
		if err != nil {
			writeMemoryError(w,http.StatusInternalServerError, "create_failed")
			return
		}
		writeJSON(w, http.StatusOK, m)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeMemoryError(w,http.StatusMethodNotAllowed, "method_not_allowed")
	}
}

func (h *Handler) handleMemoriesSubtree(w http.ResponseWriter, r *http.Request) {
	user, _, err := h.Authenticate(r)
	if err != nil {
		writeMemoryError(w,http.StatusUnauthorized, "unauthorized")
		return
	}
	idStr := strings.TrimPrefix(r.URL.Path, "/api/auth/memories/")
	idStr = strings.TrimSuffix(idStr, "/")
	if idStr == "" || strings.Contains(idStr, "/") {
		http.NotFound(w, r)
		return
	}
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		writeMemoryError(w,http.StatusBadRequest, "invalid_id")
		return
	}
	switch r.Method {
	case http.MethodPut:
		var req memoryRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeMemoryError(w,http.StatusBadRequest, "invalid_json")
			return
		}
		content := strings.TrimSpace(req.Content)
		if content == "" {
			writeMemoryError(w,http.StatusBadRequest, "empty_content")
			return
		}
		if len(content) > memoryMaxContentBytes {
			writeMemoryError(w,http.StatusBadRequest, "content_too_long")
			return
		}
		m, err := h.Store.UpdateUserMemory(r.Context(), user.ID, id, content)
		if err != nil {
			if errors.Is(err, ErrMemoryNotFound) {
				writeMemoryError(w,http.StatusNotFound, "not_found")
				return
			}
			writeMemoryError(w,http.StatusInternalServerError, "update_failed")
			return
		}
		writeJSON(w, http.StatusOK, m)
	case http.MethodDelete:
		if err := h.Store.DeleteUserMemory(r.Context(), user.ID, id); err != nil {
			if errors.Is(err, ErrMemoryNotFound) {
				writeMemoryError(w,http.StatusNotFound, "not_found")
				return
			}
			writeMemoryError(w,http.StatusInternalServerError, "delete_failed")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		w.Header().Set("Allow", "PUT, DELETE")
		writeMemoryError(w,http.StatusMethodNotAllowed, "method_not_allowed")
	}
}
