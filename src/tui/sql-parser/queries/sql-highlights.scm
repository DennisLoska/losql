(string) @string
(number) @number
(comment) @comment

(function_call
    function: (identifier) @function)

[
  (NULL)
  (TRUE)
  (FALSE)
] @constant.builtin

(identifier) @variable

[
  "::"
  "<"
  "<="
  "<>"
  "="
  ">"
  ">="
] @operator

[
  "("
  ")"
  "["
  "]"
] @punctuation.bracket

[
  ";"
  "."
] @punctuation.delimiter

[
  (type)
  (array_type)
] @type

[
 (primary_key_constraint)
 (unique_constraint)
 (null_constraint)
] @keyword

[
  "AND"
  "AS"
  "AUTO_INCREMENT"
  "CREATE"
  "CREATE_DOMAIN"
  "CREATE_OR_REPLACE_FUNCTION"
  "CREATE_SCHEMA"
  "TABLE"
  "TEMPORARY"
  "CREATE_TYPE"
  "DATABASE"
  "FROM"
  "GRANT"
  "GROUP_BY"
  "IF_NOT_EXISTS"
  "INDEX"
  "INNER"
  "INSERT"
  "INTO"
  "IN"
  "JOIN"
  "LANGUAGE"
  "LEFT"
  "LOCAL"
  "NOT"
  "ON"
  "OR"
  "ORDER_BY"
  "OUTER"
  "PRIMARY_KEY"
  "PUBLIC"
  "RETURNS"
  "SCHEMA"
  "SELECT"
  "SESSION"
  "SET"
  "TABLE"
  "TIME_ZONE"
  "TO"
  "UNIQUE"
  "UPDATE"
  "USAGE"
  "VALUES"
  "WHERE"
  "WITH"
  "WITHOUT"
] @keyword
