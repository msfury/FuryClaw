export interface ClaudeStreamMessage {
  type: "system" | "assistant" | "result" | "rate_limit_event";
  subtype?: string;
  session_id?: string;
  message?: {
    role: string;
    content: unknown[];
    model?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  result?: string;
  total_cost_usd?: number;
  is_error?: boolean;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  model_usage?: Record<
    string,
    {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    }
  >;
}

export interface ClaudeJsonResult {
  type: "result";
  subtype: "success" | "error";
  result: string;
  session_id: string;
  total_cost_usd: number;
  is_error: boolean;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}
