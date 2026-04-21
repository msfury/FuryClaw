# FuryClaw — Claude Code 세션 가이드

Claude Code CLI 프로세스를 워커로 병렬 실행하는 멀티 에이전트 오케스트레이터. PM(사용자 대화) + Planner(작업 분해) + Workers(claude CLI 프로세스) + MCP 허브(조율).

## 이 프로젝트의 SSOT는 코드다

문서가 아니라 **코드 자체가 단일 진실 원천**입니다. 규칙을 참조해야 하면 아래 파일들을 직접 읽으세요 — 중간에 요약 문서를 두고 캐싱하지 말 것(drift 위험).

| 규칙 | 권위 파일 |
|---|---|
| MCP 툴 스키마 | `src/mcp/mcp-server.ts` — `TOOL_DEFS` |
| 모델 ID | `src/config/models.ts` — `CLAUDE_MODEL_ID` |
| 언어 정책 (한국어 강제) | `src/config/models.ts` — `KOREAN_LANGUAGE_DIRECTIVE` |
| 권한 티어 | `src/permissions/permission-tier.ts` |
| 워커/PM/Planner 시스템 프롬프트 | `src/workers/worker.ts`, `src/orchestrator/pm-agent.ts`, `src/orchestrator/prompts.ts` |

## Forbidden

- **할당 스코프 외 파일 자발적 수정/삭제 금지**. 워커는 `ownFiles` 밖의 파일을 수정하지 않음. Claude Code 세션도 사용자가 지정하지 않은 파일을 자의적으로 건드리지 않음.
- **사용자가 반복 지시하면 자기 판단 폐기**. 같은 지시를 두 번 이상 받으면 내 분석이 틀렸다고 가정하고 사용자 지시를 그대로 수행.
- **MCP 툴 이름 하드코딩 금지**. 워커 프롬프트/허용 목록 모두 `TOOL_DEFS` 에서 파생. 툴 이름이 코드에 문자열 리터럴로 두 번 등장하면 그 자체가 버그 씨앗.

## Working rules

- **작업 전 관련 코드 먼저 읽기**. 문서/메모리/추측으로 시작하지 말 것.
- **계약 변경은 사용자 승인 필요**. `TOOL_DEFS` 스키마 변경, `CLAUDE_MODEL_ID` 변경, 권한 티어 변경, 워커 시스템 프롬프트의 핵심 불변식 변경 — 모두 사용자에게 먼저 설명하고 진행.
- **사용자 응답은 한국어**. 식별자·파일명·명령어는 원문 유지.
