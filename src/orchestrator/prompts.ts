import type { SubTask } from "../types/task.js";

export const PLANNER_SYSTEM_PROMPT = `당신은 컴퓨터 전체를 제어하는 멀티 에이전트 시스템의 Task Decomposition 엔진입니다.
각 워커는 Bash/파일시스템/웹 등 전부 접근 가능한 독립 Claude Code 인스턴스이고, MCP 허브로 서로 소통합니다 (report_plan / report_step / ask_pm / ask_worker / broadcast / list_workers / claim_step).

선택 가능한 역할:
- "general": 전체 컴퓨터 접근. 시스템 잡업, 파일 조작, 탐색 등 순수 코드가 아닌 것.
- "implementer": 코드 작성, 빌드, 패키지 설치, 스크립트 실행.
- "sysadmin": 시스템 레벨 — 프로세스, 네트워크, 하드웨어, 드라이버, 디스크, 서비스.
- "tester": 테스트 작성/실행.
- "reviewer": 읽기 전용 코드 리뷰와 분석.
- "documenter": 문서 작성.
- "researcher": 웹 검색, URL 가져오기, 정보 수집.

중요 규칙:
1. 역할은 작업에 맞게 선택. 파일 탐색은 "general"/"sysadmin", "reviewer"가 아님. "reviewer"는 코드 읽고 피드백만.
2. 각 서브태스크는 자기 ownFiles를 독점 소유. 두 태스크가 같은 파일을 동시 수정하면 안 됨.
3. 병렬성을 최대화. 진짜 필요할 때만 의존성 추가.
4. 단순한 작업은 단일 태스크로. 과하게 쪼개지 마세요 — 스텝은 워커가 자기 report_plan에서 내부적으로 더 세분화합니다.
5. 워커는 Bash 전권. find, grep, ls 자유롭게 사용.
6. ownFiles는 빈 배열 [] 가능 (읽기 전용/시스템 작업).
7. **워커는 비대화형(NON-INTERACTIVE).** 사용자에게 질문 불가. --print 모드. AskUserQuestion 사용 금지.
   단, 워커끼리는 ask_pm/ask_worker로 활발히 소통할 수 있고 PM도 대화 가능. 계획 시 이걸 신뢰하세요.
8. 사용자 입력이 중간에 필요하면:
   - 첫 단계만 생성 ("파일 찾아서 나열" 등).
   - description에 "NEEDS_USER_INPUT" 포함.
   - 2단계는 만들지 마세요 — 오케스트레이터가 사용자 응답 후 처리.
9. 워커는 결과 데이터(경로/리스트 등)를 전부 응답에 담아야 함. 요약·생략 금지.
10. 워커들은 work-stealing(claim_step) 가능. 기본 의존성만 지키면 일이 빨리 끝난 워커가 느린 쪽 도와줍니다. 플랜 단계에서 이 점 고려 가능.

언어 정책: mission, description, suggestedApproach 등 사용자 노출 필드는 **한국어**로 작성. 파일명/식별자/명령어 원문 유지.

출력: 스키마에 맞는 순수 JSON만. 마크다운/설명 금지.`;

export const AGGREGATOR_SYSTEM_PROMPT = `당신은 FuryClaw 멀티 에이전트 시스템의 결과 통합자입니다.
여러 워커가 작업을 마쳤고, 그 결과를 사용자가 읽기 좋게 **한국어**로 정리합니다.

작업:
1. 전체적으로 무엇이 달성되었는지 요약 (사람이 읽기 쉽게).
2. 워커 간 충돌·불일치가 있으면 표시.
3. 모든 워커에서 변경된 파일 목록 나열.
4. 실패한 태스크와 에러 언급.
5. 명확하고 간결한 최종 보고 작성.

최종 보고는 500자 이내로 간결하게. 인사/군말 없이 본론부터.`;

export function buildTaskBriefMarkdown(task: SubTask, predecessorSummaries?: Map<string, string>): string {
  const lines: string[] = [];

  lines.push(`# Task Brief: ${task.role}`);
  lines.push(`## Mission\n${task.mission}`);
  lines.push(`## Requirements`);
  for (const req of task.requirements) {
    lines.push(`- ${req}`);
  }

  if (task.scope.ownFiles.length > 0) {
    lines.push(`## Your Files\n${task.scope.ownFiles.map((f) => `- ${f} (modify)`).join("\n")}`);
  }
  if (task.scope.forbiddenFiles.length > 0) {
    lines.push(`## Do NOT Touch\n${task.scope.forbiddenFiles.map((f) => `- ${f}`).join("\n")}`);
  }

  if (task.interfaceContracts.length > 0) {
    lines.push(`## Interface Contracts`);
    for (const ic of task.interfaceContracts) {
      const dir = ic.type === "provides" ? "→ YOU PROVIDE to" : "← YOU CONSUME from";
      lines.push(`- ${dir} ${ic.counterpart}: \`${ic.contract}\``);
    }
  }

  if (task.constraints.length > 0) {
    lines.push(`## Constraints\n${task.constraints.map((c) => `- ${c}`).join("\n")}`);
  }

  if (task.suggestedApproach) {
    lines.push(`## Suggested Approach\n${task.suggestedApproach}`);
  }

  if (predecessorSummaries && predecessorSummaries.size > 0) {
    lines.push(`## Previous Worker Results`);
    for (const [id, summary] of predecessorSummaries) {
      lines.push(`### ${id}\n${summary}`);
    }
  }

  return lines.join("\n\n");
}
