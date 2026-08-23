# FuryClaw

Claude Code CLI(`claude`) 프로세스를 여러 개 병렬로 띄워서 작업을 분산 처리하는 멀티 에이전트 오케스트레이터. 중앙의 PM이 사용자와 대화하고, 워커(독립 `claude` 인스턴스)들이 실제 코드를 만집니다.

Claude API를 직접 쓰지 않고 CLI를 쓰는 이유는 **비용**입니다. 그 외 수사는 생략.

## 아키텍처


```
User
  ↕ (채팅)
PM (orchestrator/pm.ts)
  ├─ PMAgent       — 사용자와 직접 말하는 Claude 세션 (한국어 자연어, --resume 유지)
  ├─ Planner       — 사용자 요청을 서브태스크로 분해 (JSON-only 출력 강제)
  ├─ Workers[]     — 독립 claude CLI 프로세스. 각자 자기 플랜 선언·진행 보고
  └─ MCP Hub       — 워커·PM 소통 중추 (플랜/스텝/Q&A/broadcast/work-stealing)
       ↕
  Dashboard (web/)  — 채팅 + 워커 카드(플랜 진행도) + 실시간 로그 팝업
```

주요 흐름:
1. 사용자가 PMAgent(채팅)에게 작업 지시
2. Planner가 서브태스크로 분해 (역할/소유 파일/의존성/인터페이스 계약 포함)
3. PM이 의존성 순서대로 워커를 병렬 실행, MCP 설정 주입
4. 워커는 시작 직후 `report_plan`으로 3~7 스텝 선언 → `report_step`으로 진행 보고 → 필요 시 `ask_pm`/`ask_worker`/`broadcast`/`list_workers`/`claim_step`로 소통
5. PM은 중요 이벤트(플랜 선언, 스텝 전환, 완료, broadcast, work-stealing 등)를 PMAgent에 전달해 사용자에게 자연어로 중계
6. 사용자가 "지금 뭐해?"처럼 물으면 PM이 워커별 플랜·현재 스텝(n/N)·최근 활동을 종합해서 답변

PM 상태 머신: `idle → planning → executing → (waiting_user | replanning) → done | error`

## MCP 툴 (워커·PM 공통 인터페이스)

단일 진실 원천: `src/mcp/mcp-server.ts`의 `TOOL_DEFS`. 여기서 워커 시스템 프롬프트 섹션과 `--allowedTools` 목록(`MCP_TOOL_ALLOWLIST`)이 자동 파생됩니다. 워커에게는 `mcp__furyclaw__<이름>` 형태로 노출.

| 툴 | 인자 | 용도 | 블로킹 |
|---|---|---|---|
| `report_plan` | `task_id, steps[]` | 워커가 착수 직후 구체적 스텝 3~7개 선언 | — |
| `report_step` | `task_id, current, total?, title` | 각 스텝 진입 시 현재 위치(n/N) 보고. 이전 스텝은 자동 완료 | — |
| `report_done` | `task_id, summary?` | 전체 작업 완료 신호 | — |
| `ask_pm` | `from, question` | PM에게 판단 질의 (답 올 때까지 대기) | ○ |
| `ask_worker` | `from, target, question` | 다른 워커에게 질의. 바쁘면 PM이 대리 응답 | ○ |
| `broadcast` | `from, message` | 팀 전체에 중요 정보 공유 | — |
| `list_workers` | — | 다른 워커들의 플랜/진행도 조회 (중복 방지·work-stealing 탐색) | — |
| `claim_step` | `from, target, step_index` | 다른 워커의 pending 스텝을 원자적으로 가져오기 (work-stealing) | — |

전송은 HTTP JSON-RPC (기본 포트 `39999`, `mcpPort`로 변경).

## 워커 계약

Planner가 만드는 서브태스크(`src/types/task.ts`, zod 스키마)의 핵심 필드:

- `scope.ownFiles` / `readonlyFiles` / `forbiddenFiles` — 워커가 만질 수 있는 범위. **ownFiles 밖 수정 금지**
- `requirements` / `constraints` / `suggestedApproach`
- `interfaceContracts[]` — 다른 워커와 주고받는 인터페이스 (`provides` / `consumes`)
- `dependsOn[]` — 선행 태스크. PM이 이 순서대로 실행 그룹을 만듦

워커는 비대화형(`--print --output-format stream-json`)으로 돌기 때문에 사용자에게 직접 질문할 수 없습니다(`AskUserQuestion` 금지). 대신 `ask_pm`을 씁니다.

최종 보고는 stdout에 고정 포맷으로 출력하고, 오케스트레이터가 파싱합니다:

```
---RESULT---
FILES: 변경/생성된 파일 목록 (없으면 none)
DECISIONS: 핵심 결정 1 | 핵심 결정 2
NOTES: 오케스트레이터가 필요로 하는 결과 데이터 (경로/값/전체 답변, 요약 금지)
---END---
```

## 설계 원칙

- 모든 Claude 호출은 `claude-opus-4-6[1m]` 고정 (`CLAUDE_MODEL_ID` 상수). 사용자 노출 텍스트는 모두 한국어 (`KOREAN_LANGUAGE_DIRECTIVE`).
- **PM은 수다스럽게**. 주요 이벤트마다 사용자에게 자연어로 상황 공유. 하드코딩 영어 상태 문자열 금지.
- **워커는 플랜과 스텝을 구체적으로 선언**. 추상어("작업하기") 금지. 3~7 단계로 분해.
- **워커 출력은 기계 포맷, 사람 대상 요약은 오케스트레이터가**. 출력 토큰 절약.
- **W↔W 조율**. 중복 태스크는 `list_workers`로 사전 감지, 내 일이 빨리 끝나면 `claim_step`으로 느린 워커 도움. `broadcast`로 발견 즉시 공유.
- **띄우는 Claude는 무한 권한**. Planner/Aggregator/Worker는 비대화형이라 권한 프롬프트 처리자가 없음 → `--dangerously-skip-permissions` 기본. `permission-tier.ts`의 티어 정의는 장기적으로 사용자 대화형 세션용 참고자료.
- **코드가 SSOT**. 규칙 문서보다 `TOOL_DEFS`·`CLAUDE_MODEL_ID`·`KOREAN_LANGUAGE_DIRECTIVE` 같은 코드 상수가 권위. 자세한 건 `CLAUDE.md` 참조.

## 설치

```bash
git clone <repo>
cd FuryClaw
npm install
npm run build
```

전제: `claude` 명령이 PATH에 있어야 함 (Claude Code CLI 설치 필요). Node >= 18.

## 사용법

### 웹 대시보드

```bash
npm start -- web --dir /your/project --port 3000
```

브라우저에서 `http://localhost:3000` 열고 채팅으로 작업 지시. 각 워커 카드에 플랜 체크리스트(`✅▶️⬜🫳`)와 진행바가 실시간 표시되고, 로그 팝업에서 PM·워커 원본 이벤트를 볼 수 있습니다.

### CLI 원샷

```bash
npm start -- run "리팩토링 할 것들 찾아서 고쳐줘" --dir /your/project
```

PM/워커 발화가 터미널에 스트리밍되고, 완료 시 누적 비용을 출력합니다.

### 옵션

```
furyclaw web [옵션]
  -c, --concurrency <n>    동시 실행 워커 수 (기본 3)
  -m, --model <model>      모델 (opus/sonnet/haiku, 기본 opus)
  -e, --effort <level>     추론 강도 (low/medium/high/max, 기본 max)
  -p, --permission <mode>  권한 모드 (strict/auto/unrestricted, 기본 unrestricted)
  -d, --dir <path>         워킹 디렉터리 (기본 cwd)
      --port <port>        대시보드 포트 (기본 3000)

furyclaw run <task> [옵션]  # 위와 동일 (--port 대신) + --budget <usd> 예산 상한
```

## 프로젝트 설정 (`.furyclaw.json`)

워킹 디렉터리에 두면 기본값을 덮어씀. CLI 옵션 > `.furyclaw.json` > `DEFAULT_CONFIG` 순으로 병합되고, `roles`는 키 단위로 얕게 병합됩니다.

```json
{
  "concurrency": 5,
  "defaultModel": "opus",
  "effort": "high",
  "permissionMode": "unrestricted",
  "mcpPort": 39999,
  "maxBudgetUsd": 10,
  "roles": {
    "myrole": {
      "description": "역할 설명",
      "systemPromptSuffix": "이 역할이 하는 일",
      "allowedTools": ["Read", "Write", "Edit", "Glob", "Grep", "Bash"]
    }
  }
}
```

기본 역할(`src/types/config.ts`의 `DEFAULT_CONFIG.roles`) — 아래에 명시된 것 외에는 전 도구 접근:

| 역할 | 용도 |
|---|---|
| `general` | 범용. 폴백 역할 (Planner가 모르는 role을 주면 여기로) |
| `implementer` | 기능 구현, 빌드/패키지 설치/스크립트 실행 |
| `sysadmin` | 파일·프로세스·네트워크·하드웨어 등 시스템 작업 |
| `tester` | 테스트 작성·실행 |
| `reviewer` | 코드 리뷰 (읽기 전용: Read/Glob/Grep/Bash) |
| `documenter` | 문서 작성 (Read/Write/Edit/Glob/Grep/Bash) |
| `researcher` | 웹·로컬 조사 (WebFetch/WebSearch 포함, 쓰기 도구 없음) |

## 권한 모드

`permission-tier.ts`가 모드별로 워커 spawn 플래그와 도구 목록을 결정합니다.

| 모드 | claude CLI 플래그 | allowedTools |
|---|---|---|
| `unrestricted` (기본) | `--dangerously-skip-permissions` | 필터 없음 (역할 정의 그대로, `--allowedTools` 자체를 붙이지 않음) |
| `auto` | `--permission-mode auto` | 역할 정의 + MCP 툴 allowlist |
| `strict` | `--permission-mode default` | 위와 동일하되 `reviewer`는 읽기 전용으로 축소 |

`checkPermission()`은 금융 행위·PII 유출·프로덕션 파괴 패턴만 `require_human`/`warn`으로 올리고 나머지는 자동 승인합니다. 현재 기본 경로(`unrestricted`)에서는 호출되지 않는 참고 구현.

## 로그 / 디버깅

- 런타임 로그: `<tmpdir>/furyclaw/runtime.log` (append). 기동 시 CLI가 경로를 출력.
- `warn`/`error`는 stderr에도 미러링.
- Planner/워커의 `claude` 호출이 실패하면 raw stdout/stderr를 `<tmpdir>/furyclaw/<component>-<suffix>-<ts>.txt`로 덤프하고 경로를 에러 메시지에 포함 (`dumpToFile`).
- 대시보드 로그 팝업에서 PM·워커별 원본 이벤트 확인 가능.

## 디렉터리 구조

```
src/
  cli.ts                     # 진입점 (run/web 서브커맨드)
  index.ts                   # 라이브러리 export (ProjectManager, planTask, runWorker, ...)
  config/
    config.ts                # .furyclaw.json 로더 + 병합
    models.ts                # CLAUDE_MODEL_ID, KOREAN_LANGUAGE_DIRECTIVE
  orchestrator/
    pm.ts                    # PM 데몬. MCP 이벤트 처리, 워커 상태 관리, PMAgent 연결
    pm-agent.ts              # PM의 Claude 세션 (리액티브 Q&A, --resume 유지)
    planner.ts               # 작업 분해 + 실패 시 raw 출력 덤프
    prompts.ts               # Planner/Aggregator 시스템 프롬프트
    aggregator.ts            # 최종 결과 통합
    orchestrator.ts          # CLI 원샷용 plan→execute→aggregate 파이프라인
  workers/
    worker.ts                # 워커 spawn. 시스템 프롬프트를 TOOL_DEFS에서 파생
    worker-manager.ts        # 병렬 실행/의존성 (CLI 모드)
    stream-parser.ts         # claude stream-json 파서
  mcp/
    mcp-server.ts            # TOOL_DEFS(SSOT) + HTTP JSON-RPC 허브
  permissions/
    permission-tier.ts       # 권한 모드 → CLI 플래그/도구 필터, 티어 판정
  utils/
    logger.ts                # runtime.log 로거 + dumpToFile
  web/
    server.ts                # HTTP + WebSocket
    public/index.html        # 대시보드 UI (플랜/스텝/로그 시각화)
  types/
    task.ts                  # SubTask/TaskPlan 스키마 (zod), WorkerResult
    config.ts                # 설정 타입 + DEFAULT_CONFIG(역할 정의)
    claude-output.ts         # Claude stream-json 타입
```

## 대시보드 HTTP API

| 엔드포인트 | 메서드 | 설명 |
|---|---|---|
| `/api/message` | POST | `{ text }` — 사용자 채팅 메시지 전달 |
| `/api/config` | POST | 실행 중 설정 변경 (model/effort/concurrency 등) |
| `/api/state` | GET | 현재 status, 워커 수, 누적 비용 |
| `/` (WebSocket) | — | PM 상태 스냅샷 실시간 푸시 |

## 개발

```bash
npm run dev -- web --dir /your/project   # tsx로 즉시 실행
npm run build                             # dist/로 컴파일
npm test                                  # vitest
```

Claude Code 세션에서 이 저장소를 작업한다면 `CLAUDE.md`를 먼저 읽을 것 — forbidden 목록과 working rule이 정리돼 있음.

## 상태

동작 확인:
- `tsc` clean, CLI 서브커맨드 기동 OK
- MCP 서버 스모크: 8개 툴 노출, `report_plan`/`list_workers` 저장·조회 round-trip, `ask_pm` 블로킹 왕복 ~140ms 정상

미확인 / 다음 할 일:
- 실제 `claude` CLI 워커를 띄워 MCP 연결 end-to-end 확인 (Claude Code의 `type: "http"` 호환성 최종 검증)
- 실행 중 사용자가 방향 수정 지시했을 때 워커 interrupt / re-plan (`replanning` 상태는 타입에만 정의돼 있음)
- PM 발화 빈도 튜닝 (이벤트마다 PMAgent 호출하므로 토큰 부담 가능)
- `.furyclaw.json.example`이 초기 구현 시점 스키마(sonnet/auto, 구 역할 3종)라 현재 기본값과 어긋남 — 갱신 필요
