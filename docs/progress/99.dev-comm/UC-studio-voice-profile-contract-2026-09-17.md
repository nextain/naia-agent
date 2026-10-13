# UC-STUDIO-VOICE contract — 2026-09-17

Parent: [alpha-adk#47](https://github.com/nextain/alpha-adk/issues/47) / [alpha-adk#48](https://github.com/nextain/alpha-adk/issues/48)

## Boundary
- Code owner: `src/main/domain/studio-voice-profile.ts`
- Tests: `src/test/studio-voice-profile.contract.test.ts`
- Data instances may live under alpha-adk `naia-settings/` or gateway metadata; this module does not read those paths.

## Invariants
1. VoiceProfile never accepts NVA manifest shape (`nva_version` / `animations` keys ⇒ reject).
2. Generation gate fails closed on non-granted / revoked / expired / scope miss.
3. No audio payload fields; `storageLocator` rejects absolute paths and `..` segments.
4. `derivativePolicy` is recorded but not executed here.
