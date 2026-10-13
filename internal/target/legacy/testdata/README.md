# Historical T3 schema snapshots

`t3-schemas.json` contains the DDL and migration rows used to test the legacy
adapter against T3 migrations 40–53. Each entry records the exact T3 source
commit from which its schema was generated. The snapshots contain schema
definitions and migration metadata only; they contain no T3 runtime code or
user data.

T3 Code is MIT-licensed. The source repository and license are available at
https://github.com/pingdotgg/t3code.
