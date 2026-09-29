package ouimage

// Private originals must never be sent to a public image host. Unsupported
// formats and oversized images retain their normal local upload path.
func CanPublish(visibility, mimeType string, size int64) bool {
	return visibility == "public" && SupportedMIME(mimeType) && size > 0 && size <= MaxImageBytes
}
