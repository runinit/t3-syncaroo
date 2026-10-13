// Package contract defines versioned JSON shapes at the Go CLI boundary.
package contract

type ResultEnvelope[T any] struct {
	SchemaVersion int `json:"schemaVersion"`
	Result        T   `json:"result"`
}

type ErrorEnvelope struct {
	SchemaVersion int    `json:"schemaVersion"`
	Status        string `json:"status,omitempty"`
	Error         string `json:"error"`
}

type DiscoveryEnvelope[T any] struct {
	SchemaVersion int `json:"schemaVersion"`
	Conversations T   `json:"conversations"`
	Outcomes      any `json:"outcomes,omitempty"`
}
