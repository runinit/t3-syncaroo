// Package assets plans and safely materializes local image attachments.
package assets

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/runinit/t3-syncaroo/internal/domain"
)

type Descriptor struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	MIMEType  string `json:"mimeType"`
	SizeBytes int64  `json:"sizeBytes"`
}

type Asset struct {
	Descriptor Descriptor
	Data       []byte
	HasData    bool
	SourcePath string
	FinalPath  string
}

var extensionByMIME = map[string]string{
	"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
}

// PlanMessage mirrors T3 image limits and records skipped image names in the
// message body so the user can still find source material that was not copied.
func PlanMessage(message domain.CanonicalMessage, threadID, attachmentsDir string) (string, []Descriptor, []Asset, []string) {
	var descriptors []Descriptor
	var assets []Asset
	var warnings, notes []string
	for _, attachment := range message.Attachments[:min(8, len(message.Attachments))] {
		extension := extensionByMIME[attachment.MIMEType]
		reason := ""
		switch {
		case attachment.RemoteURL != nil:
			reason = "remote images are not downloaded"
		case extension == "":
			reason = "unsupported MIME type " + attachment.MIMEType
		case attachment.SizeBytes > 10*1024*1024:
			reason = "image exceeds 10 MB"
		}
		if reason != "" {
			warnings = append(warnings, fmt.Sprintf("Skipped %s: %s.", attachment.Name, reason))
			reference := attachment.Name
			if attachment.RemoteURL != nil {
				reference = *attachment.RemoteURL
			}
			notes = append(notes, "[Attachment not imported: "+reference+"]")
			continue
		}
		id := safeSegment(threadID) + "-" + deterministicUUID("t3-import:attachment:"+threadID+":"+attachment.SourceID)
		name := attachmentName(attachment.Name, extension)
		descriptor := Descriptor{Type: "image", ID: id, Name: name, MIMEType: attachment.MIMEType, SizeBytes: attachment.SizeBytes}
		asset := Asset{Descriptor: descriptor, FinalPath: filepath.Join(attachmentsDir, id+extension)}
		if attachment.Data != nil {
			asset.Data = append([]byte(nil), attachment.Data.Data...)
			asset.HasData = true
		}
		if attachment.Path != nil {
			asset.SourcePath = *attachment.Path
		}
		descriptors = append(descriptors, descriptor)
		assets = append(assets, asset)
	}
	if len(message.Attachments) > 8 {
		warnings = append(warnings, fmt.Sprintf("Message %s has more than eight images; extras were skipped.", message.SourceID))
	}
	parts := make([]string, 0, 1+len(notes))
	if message.Text != "" {
		parts = append(parts, message.Text)
	}
	parts = append(parts, notes...)
	return strings.Join(parts, "\n\n"), descriptors, assets, warnings
}

// Materialize stages every image before making it visible. The returned
// rollback removes only files created by this call and is used if the database
// transaction fails after asset staging.
func Materialize(attachmentsDir string, planned []Asset) (created []string, rollback func(), err error) {
	if len(planned) == 0 {
		return nil, func() {}, nil
	}
	if err := os.MkdirAll(attachmentsDir, 0o700); err != nil {
		return nil, nil, fmt.Errorf("assets: create attachment directory: %w", err)
	}
	if info, err := os.Lstat(attachmentsDir); err != nil {
		return nil, nil, fmt.Errorf("assets: inspect attachment directory: %w", err)
	} else if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, nil, fmt.Errorf("assets: attachment directory must be a real directory: %s", attachmentsDir)
	}
	stage, err := os.MkdirTemp(attachmentsDir, ".t3-import-staging-")
	if err != nil {
		return nil, nil, fmt.Errorf("assets: create staging directory: %w", err)
	}
	rollback = func() {
		for _, path := range created {
			_ = os.Remove(path)
		}
		_ = os.RemoveAll(stage)
	}
	for index, asset := range planned {
		if filepath.Clean(filepath.Dir(asset.FinalPath)) != filepath.Clean(attachmentsDir) {
			rollback()
			return nil, nil, fmt.Errorf("assets: destination escapes attachment directory: %s", asset.FinalPath)
		}
		content, err := readAsset(asset)
		if err != nil {
			rollback()
			return nil, nil, err
		}
		if int64(len(content)) != asset.Descriptor.SizeBytes {
			rollback()
			return nil, nil, fmt.Errorf("attachment %s changed size before it could be staged", asset.Descriptor.Name)
		}
		if info, statErr := os.Lstat(asset.FinalPath); statErr == nil {
			if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
				rollback()
				return nil, nil, fmt.Errorf("refusing to overwrite non-file attachment %s", asset.FinalPath)
			}
			existing, readErr := os.ReadFile(asset.FinalPath)
			if readErr != nil || !bytes.Equal(existing, content) {
				rollback()
				return nil, nil, fmt.Errorf("existing T3 image %s does not match source session; preserve it and resolve the attachment conflict before retrying", asset.Descriptor.Name)
			}
			continue
		} else if !os.IsNotExist(statErr) {
			rollback()
			return nil, nil, fmt.Errorf("assets: inspect final image: %w", statErr)
		}
		temporary := filepath.Join(stage, fmt.Sprintf("asset-%d", index))
		if err := writeVerified(temporary, content); err != nil {
			rollback()
			return nil, nil, err
		}
		if err := os.Rename(temporary, asset.FinalPath); err != nil {
			rollback()
			return nil, nil, fmt.Errorf("assets: publish image %s: %w", asset.Descriptor.Name, err)
		}
		created = append(created, asset.FinalPath)
	}
	if err := os.RemoveAll(stage); err != nil {
		rollback()
		return nil, nil, fmt.Errorf("assets: remove staging directory: %w", err)
	}
	rollback = func() {
		for _, path := range created {
			_ = os.Remove(path)
		}
	}
	return created, rollback, nil
}

func readAsset(asset Asset) ([]byte, error) {
	if asset.HasData {
		return append([]byte(nil), asset.Data...), nil
	}
	if asset.SourcePath == "" {
		return nil, fmt.Errorf("attachment %s has no readable local data", asset.Descriptor.Name)
	}
	file, err := os.Open(asset.SourcePath)
	if err != nil {
		return nil, fmt.Errorf("attachment %s: read source: %w", asset.Descriptor.Name, err)
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 10*1024*1024+1))
	if err != nil {
		return nil, fmt.Errorf("attachment %s: read source: %w", asset.Descriptor.Name, err)
	}
	return data, nil
}

func writeVerified(path string, content []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("assets: stage image: %w", err)
	}
	_, writeErr := file.Write(content)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil {
		return fmt.Errorf("assets: stage image: %w", writeErr)
	}
	if syncErr != nil {
		return fmt.Errorf("assets: sync staged image: %w", syncErr)
	}
	if closeErr != nil {
		return fmt.Errorf("assets: close staged image: %w", closeErr)
	}
	verified, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("assets: verify staged image: %w", err)
	}
	if sha256.Sum256(verified) != sha256.Sum256(content) {
		return fmt.Errorf("assets: staged image content verification failed")
	}
	return nil
}

func deterministicUUID(value string) string {
	hash := sha256.Sum256([]byte(value))
	b := append([]byte(nil), hash[:16]...)
	b[6] = (b[6] & 0x0f) | 0x50
	b[8] = (b[8] & 0x3f) | 0x80
	hexValue := hex.EncodeToString(b)
	return hexValue[:8] + "-" + hexValue[8:12] + "-" + hexValue[12:16] + "-" + hexValue[16:20] + "-" + hexValue[20:]
}

var unsafeSegment = regexp.MustCompile(`[^a-z0-9_-]+`)

func safeSegment(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = unsafeSegment.ReplaceAllString(value, "-")
	value = strings.Trim(value, "-_")
	if len(value) > 80 {
		value = value[:80]
	}
	return strings.TrimRight(value, "-_")
}

func attachmentName(value, extension string) string {
	name := strings.TrimSpace(filepath.Base(value))
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, name)
	if name == "" || name == "." || name == string(filepath.Separator) {
		name = "image"
	}
	if len(name) > 240 {
		name = name[:240]
	}
	if filepath.Ext(name) == "" {
		name += extension
	}
	return name
}
