# FuryClaw

Claude Code CLI(`claude`) 프로세스를 여러 개 병렬로 띄워서 작업을 분산 처리하는 멀티 에이전트 오케스트레이터. 중앙의 PM이 사용자와 대화하고, 워커(독립 `claude` 인스턴스)들이 실제 코드를 만집니다.

Claude API를 직접 쓰지 않고 CLI를 쓰는 이유는 **비용**입니다. 그 외 수사는 생략.

## 아키텍처

```
User
  ↕ (채팅)
PM (orchestrator/pm.ts)
  ├─ PMAgent       — 사용자와 직접 말하는 Claude 세션 (한국어 자연어)
  ├─ Planner       — 사용자 요청을 서브태스크로 분해
  ├─ Workers[]     — 독립 claude CLI 프로세스. 각자 자기 플랜 선언·진행 보고
  └─ MCP Hub       — 워커·PM 소통 중추 (플랜/스텝/Q&A/work-stealing)
       ↕
  Dashboard (web/)  — 채팅 + 워커 카드(플랜 진행도) + 실시간 로그
```

주요 흐름:
1. 사용자가 PMAgent(채팅)에게 작업 지시
2. Planner가 서브태스크로 분해 (역할/소유 파일/의존성 포함)
3. PM이 의존성 순서대로 워커를 병렬 실행, MCP 설정 주입
4. 워커는 시작 직후 `report_plan`으로 3~7 스텝 선언 → `report_step`으로 진행 보고 → 필요 시 `ask_pm`/`ask_worker`/`broadcast`/`list_workers`/`claim_step`로 소통
5. PM은 중요 이벤트(플랜 선언, 스텝 전환, 완료, broadcast, work-stealing 등)를 PMAgent에 전달해 사용자에게 자연어로 중계
6. 사용자가 "지금 뭐해?"처럼 물으면 PM이 워커별 플랜·현재 스텝(n/N)·최근 활동을 종합해서 답변

## MCP 툴 (워커·PM 공통 인터페이스)

단일 진실 원천: `src/mcp/mcp-server.ts`의 `TOOL_DEFS`. 여기서 워커 시스템 프롬프트와 `--allowedTools` 목록이 자동 파생됩니다.

| 툴 | 용도 | 블로킹 |
|---|---|---|
| `report_plan` | 워커가 착수 직후 구체적 스텝 3~7개 선언 | — |
| `report_step` | 각 스텝 진입 시 현재 위치(n/total) 보고 | — |
| `report_done` | 전체 작업 완료 신호 | — |
| `ask_pm` | PM에게 판단 질의 (답 올 때까지 대기) | ○ |
| `ask_worker` | 다른 워커에게 질의. 바쁘면 PM이 대리 응답 | ○ |
| `broadcast` | 팀 전체에 중요 정보 공유 | — |
| `list_workers` | 다른 워커들의 플랜/진행도 조회 (중복 방지·work-stealing 탐색) | — |
| `claim_step` | 다른 워커의 pending 스텝을 원자적으로 가져오기 (work-stealing) | — |

## 설계 원칙

- 모든 Claude 호출은 `claude-opus-4-6[1m]` 고정 (`CLAUDE_MODEL_ID` 상수). 사용자 노출 텍스트는 모두 한국어.
- **PM은 수다스럽게**. 주요 이벤트마다 사용자에게 자연어로 상황 공유. 하드코딩 영어 상태 문자열 금지.
- **워커는 플랜과 스텝을 구체적으로 선언**. 추상어("작업하기") 금지. 3~7 단계로 분해.
- **W↔W 조율**. 중복 태스크는 `list_workers`로 사전 감지, 내 일이 빨리 끝나면 `claim_step`으로 느린 워커 도움. `broadcast`로 발견 즉시 공유.
- **권한 티어**. 재정·개인정보 외부 전송만 사용자 승인, 파일 조작/빌드/테스트/로컬 git은 자동 허용 (`src/permissions/permission-tier.ts`).
- **코드가 SSOT**. 규칙 문서보다 `TOOL_DEFS`·`CLAUDE_MODEL_ID`·`KOREAN_LANGUAGE_DIRECTIVE` 같은 코드 상수가 권위. 자세한 건 `CLAUDE.md` 참조.

## 설치

```bash
git clone <repo>
cd FuryClaw
npm install
npm run build
```

전제: `claude` 명령이 PATH에 있어야 함 (Claude Code CLI 설치 필요).

## 사용법

### 웹 대시보드

```bash
npm start -- web --dir /your/project --port 3000
```

브라우저에서 `http://localhost:3000` 열고 채팅으로 작업 지시. 각 워커 카드에 플랜 체크리스트(`✅▶️⬜🫳`)와 진행바가 실시간 표시됩니다.

### CLI 원샷

```bash
npm start -- run "리팩토링 할 것들 찾아서 고쳐줘" --dir /your/project
```

### 옵션

```
furyclaw web [옵션]
  -c, --concurrency <n>    동시 실행 워커 수 (기본 3)
  -m, --model <model>      모델 (opus/sonnet/haiku, 기본 opus)
  -e, --effort <level>     추론 강도 (low/medium/high/max, 기본 max)
  -p, --permission <mode>  권한 모드 (strict/auto/unrestricted, 기본 auto)
  -d, --dir <path>         워킹 디렉터리
      --port <port>        대시보드 포트 (기본 3000)

furyclaw run <task> [옵션]  # 위와 동일 + --budget <usd> 예산 상한
```

## 프로젝트 설정 (`.furyclaw.json`)

워킹 디렉터리에 두면 기본값을 덮어씀:

```json
{
  "concurrency": 5,
  "effort": "high",
  "permissionMode": "auto",
  "maxBudgetUsd": 10
}
```

## 디렉터리 구조

```
src/
  cli.ts                     # 진입점 (run/web 서브커맨드)
  config/
    config.ts                # .furyclaw.json 로더
    models.ts                # CLAUDE_MODEL_ID, KOREAN_LANGUAGE_DIRECTIVE
  orchestrator/
    pm.ts                    # PM 데몬. MCP 이벤트 처리, 워커 상태 관리, PMAgent 연결
    pm-agent.ts              # PM의 Claude 세션 (리액티브 Q&A, --resume 유지)
    planner.ts               # 작업 분해
    prompts.ts               # Planner/Aggregator 시스템 프롬프트
    aggregator.ts            # 최종 결과 통합
  workers/
    worker.ts                # 워커 spawn. 시스템 프롬프트를 TOOL_DEFS에서 파생
    worker-manager.ts        # 병렬 실행/의존성 (CLI 모드)
    stream-parser.ts         # claude stream-json 파서
  mcp/
    mcp-server.ts            # TOOL_DEFS(SSOT) + HTTP JSON-RPC 허브
  permissions/
    permission-tier.ts       # 권한 티어 (financial/PII require human)
  web/
    server.ts                # HTTP + WebSocket
    public/index.html        # 대시보드 UI (플랜/스텝/로그 시각화)
  types/
    task.ts                  # SubTask/TaskPlan 스키마 (zod)
    config.ts                # 설정 타입
    claude-output.ts         # Claude stream-json 타입
```

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
- 실행 중 사용자가 방향 수정 지시했을 때 워커 interrupt / re-plan
- PM 발화 빈도 튜닝 (이벤트마다 PMAgent 호출하므로 토큰 부담 가능)
