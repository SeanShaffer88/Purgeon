# Declarative plugins (API version 2)

This hardening change intentionally stops executing plugin JavaScript. Legacy
API1 `script.js` plugins are unsupported and remain disabled. This is a breaking
security change, not a claim that Node vm can safely isolate hostile code.

Place a manifest in `plugins/<id>/manifest.json` under the application's data
directory. IDs contain only ASCII letters, digits, hyphen and underscore, start
with a letter or digit, and are at most 64 characters. Example:

```json
{
  "id": "vendor_rules",
  "apiVersion": 2,
  "version": "1.0.0",
  "name": "Vendor cleanup suggestions",
  "enabled": false,
  "leftoverRules": [
    { "kind": "dir", "path": "C:\\Apps\\ExampleVendor\\ExampleApp" }
  ]
}
```

Only exact file/directory paths can be suggested. There are no executable
commands, script evaluation, network access, wildcard traversal, or deletion APIs
in this rule format. Protected paths and invalid rules are refused. Suggestions
remain unchecked and still pass Purgeon's normal removal checks.

Enabling explicitly stores approval for the current ID, version and complete rule
list. Changing those contents requires approval again. Disabling removes approval.
Validation only reports status; it never silently approves a newly changed rule.
Approvals and security settings do not sync to other computers.

Limits: at most 128 rules, manifest text at most 256 KiB, each path at most 1,024
characters. These checks are source implementation, with runtime/adversarial
validation deferred under the user's no-further-tests instruction.
