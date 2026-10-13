package assets

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CarlosGtrz/t3-import/internal/domain"
)

func TestPlanMessageBuildsStableImageDescriptorAndSkipNote(t *testing.T) {
	remote := "https://example.invalid/image.png"
	message := domain.CanonicalMessage{
		SourceID: "user-1", Text: "look", Attachments: []domain.SourceAttachment{
			{SourceID: "image-1", Name: "photo", MIMEType: "image/png", SizeBytes: 3, Data: &domain.Buffer{Data: []byte{1, 2, 3}}},
			{SourceID: "remote-1", Name: "remote.png", MIMEType: "image/png", SizeBytes: 3, RemoteURL: &remote},
		},
	}
	attachmentsDir := filepath.Join(t.TempDir(), "attachments")
	text, descriptors, planned, warnings := PlanMessage(message, "thread/id", attachmentsDir)
	if len(descriptors) != 1 || len(planned) != 1 || len(warnings) != 1 {
		t.Fatalf("descriptors=%d planned=%d warnings=%v", len(descriptors), len(planned), warnings)
	}
	if descriptors[0].ID != "thread-id-"+deterministicUUID("t3-import:attachment:thread/id:image-1") {
		t.Fatalf("unexpected attachment ID: %s", descriptors[0].ID)
	}
	if descriptors[0].Name != "photo.png" || planned[0].FinalPath != filepath.Join(attachmentsDir, descriptors[0].ID+".png") {
		t.Fatalf("unexpected descriptor/asset: %+v %+v", descriptors[0], planned[0])
	}
	if !strings.Contains(text, "[Attachment not imported: "+remote+"]") {
		t.Fatalf("skipped attachment note missing: %q", text)
	}
}

func TestMaterializeCreatesAndRollsBackOnlyNewFiles(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "attachments")
	final := filepath.Join(dir, "thread-image.png")
	asset := Asset{Descriptor: Descriptor{Name: "image.png", SizeBytes: 3}, Data: []byte{1, 2, 3}, HasData: true, FinalPath: final}
	created, rollback, err := Materialize(dir, []Asset{asset})
	if err != nil {
		t.Fatal(err)
	}
	if len(created) != 1 {
		t.Fatalf("created = %v", created)
	}
	if data, err := os.ReadFile(final); err != nil || string(data) != string([]byte{1, 2, 3}) {
		t.Fatalf("materialized data = %v, %v", data, err)
	}
	rollback()
	if _, err := os.Stat(final); !os.IsNotExist(err) {
		t.Fatalf("rollback left newly created file: %v", err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(final, []byte("foreign"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Materialize(dir, []Asset{asset}); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("conflicting existing attachment error = %v", err)
	}
	if data, err := os.ReadFile(final); err != nil || string(data) != "foreign" {
		t.Fatalf("conflicting file was not preserved: %q, %v", data, err)
	}
}

func TestMaterializeRejectsEscapingDestinationAndSymlinkRoot(t *testing.T) {
	dir := t.TempDir()
	asset := Asset{Descriptor: Descriptor{Name: "image.png", SizeBytes: 1}, Data: []byte{1}, HasData: true, FinalPath: filepath.Join(dir, "outside.png")}
	_, _, err := Materialize(filepath.Join(dir, "attachments"), []Asset{asset})
	if err == nil || !strings.Contains(err.Error(), "escapes") {
		t.Fatalf("escaping destination error = %v", err)
	}
	root := filepath.Join(dir, "link")
	if err := os.Symlink(filepath.Join(dir, "real"), root); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, _, err := Materialize(root, []Asset{{Descriptor: Descriptor{SizeBytes: 1}, Data: []byte{1}, HasData: true, FinalPath: filepath.Join(root, "asset")}}); err == nil {
		t.Fatal("symlink attachment root was accepted")
	}
}
