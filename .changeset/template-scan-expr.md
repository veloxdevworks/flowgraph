---
"@flowgraph/expr": patch
---

`renderTemplate` and `collectRefs` find `{{ … }}` blocks with a linear scan instead of a lazy regular expression, so a template with many unclosed `{{` (such as `"{{ ".repeat(n)`) no longer takes time quadratic in its length. Output is unchanged. New exports `scanTemplate` and `soleTemplateExpr` (with types `TemplateScan` and `TemplateSpan`) let other packages find the same blocks.
