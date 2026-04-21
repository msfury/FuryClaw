// 모든 Claude 호출이 공통으로 사용하는 모델 ID.
// 워커 / PM / Planner / 세션 재개 전부 여기서 가져감.
export const CLAUDE_MODEL_ID = "claude-opus-4-6[1m]";

// 시스템 프롬프트 공통 접두. 모든 Claude 호출에 붙여서 한국어 응답을 강제.
export const KOREAN_LANGUAGE_DIRECTIVE = `언어 정책: 사용자에게 보이는 모든 응답은 반드시 한국어로 작성하세요.
- 코드 식별자, 파일명, 명령어, 에러 메시지의 원문은 그대로 유지.
- 주석/문서화는 기본 한국어 (언어가 강제되는 경우 예외).
- 영어 보고서/영어 채팅 금지. 전부 한국어.`;
