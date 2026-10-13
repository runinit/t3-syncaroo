// Package registry provides the provider-neutral source adapter selection.
package registry

import (
	"fmt"

	"github.com/CarlosGtrz/t3-import/internal/domain"
	"github.com/CarlosGtrz/t3-import/internal/source/claude"
	"github.com/CarlosGtrz/t3-import/internal/source/codex"
)

type Registry struct {
	adapters map[domain.SourceName]domain.SourceAdapter
}

func New() *Registry {
	return &Registry{adapters: map[domain.SourceName]domain.SourceAdapter{
		domain.SourceCodex:  codex.New(),
		domain.SourceClaude: claude.New(""),
	}}
}

func NewWith(adapters ...domain.SourceAdapter) *Registry {
	registry := &Registry{adapters: make(map[domain.SourceName]domain.SourceAdapter, len(adapters))}
	for _, adapter := range adapters {
		if adapter != nil && adapter.Name().Valid() {
			registry.adapters[adapter.Name()] = adapter
		}
	}
	return registry
}

func (r *Registry) Get(name domain.SourceName) (domain.SourceAdapter, error) {
	if !name.Valid() {
		return nil, fmt.Errorf("unsupported source %q; choose codex or claude", name)
	}
	adapter := r.adapters[name]
	if adapter == nil {
		return nil, fmt.Errorf("no adapter is registered for source %q", name)
	}
	return adapter, nil
}

func (r *Registry) Names() []domain.SourceName {
	return []domain.SourceName{domain.SourceCodex, domain.SourceClaude}
}
