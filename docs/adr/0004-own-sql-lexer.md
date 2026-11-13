# A hand-written SQL lexer instead of tree-sitter

SQL and JSON highlighting come from small tokenizers in `src/core/sql`, not from tree-sitter grammars. losql needs a lexer anyway to split a Buffer into Statements, to find the Statement under the cursor, and to classify a Statement as read or write; using the same tokens for colour gives synchronous, offline highlighting with no flicker.

The previous tree-sitter setup downloaded the SQL grammar from a remote URL at startup, highlighted asynchronously, and needed a worker file copied next to the compiled binary. OpenTUI bundles neither a SQL nor a JSON grammar.

**Consequences:** highlighting is lexical, so it colours a word as a function only when it is followed by `(` and cannot tell a column from a table. That is accepted.
