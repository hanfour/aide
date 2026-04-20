// Minimal shared types for OpenAI ↔ Anthropic request/response translation.
// These shapes cover the fields our translators actually touch — not a full SDK mirror.

// ---------------------------------------------------------------------------
// OpenAI Chat Completions → Anthropic Messages (request side)
// ---------------------------------------------------------------------------

export interface OpenAITextPart {
  type: 'text'
  text: string
}

export interface OpenAIImageURLPart {
  type: 'image_url'
  image_url: { url: string; detail?: string }
}

export type OpenAIContentPart = OpenAITextPart | OpenAIImageURLPart

export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAIContentPart[] | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  name?: string
}

export interface OpenAIFunctionDef {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface OpenAITool {
  type: 'function'
  function: OpenAIFunctionDef
}

export type OpenAIToolChoiceAuto = 'auto'
export type OpenAIToolChoiceNone = 'none'
export interface OpenAIToolChoiceNamed {
  type: 'function'
  function: { name: string }
}
export type OpenAIToolChoice = OpenAIToolChoiceAuto | OpenAIToolChoiceNone | OpenAIToolChoiceNamed

export interface OpenAIChatRequest {
  model: string
  messages: OpenAIChatMessage[]
  tools?: OpenAITool[]
  tool_choice?: OpenAIToolChoice
  max_tokens?: number
  temperature?: number
  top_p?: number
  stream?: boolean
  stream_options?: unknown
}

// ---------------------------------------------------------------------------
// Anthropic Messages request shape
// ---------------------------------------------------------------------------

export interface AnthropicTextBlock {
  type: 'text'
  text: string
}

export interface AnthropicImageSourceBase64 {
  type: 'base64'
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  data: string
}

export interface AnthropicImageSourceURL {
  type: 'url'
  url: string
}

export interface AnthropicImageBlock {
  type: 'image'
  source: AnthropicImageSourceBase64 | AnthropicImageSourceURL
}

export interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | AnthropicTextBlock[]
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export interface AnthropicToolDef {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

export type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string }

export interface AnthropicMessagesRequest {
  model: string
  messages: AnthropicMessage[]
  system?: string
  tools?: AnthropicToolDef[]
  tool_choice?: AnthropicToolChoice
  max_tokens: number
  temperature?: number
  top_p?: number
  stream?: boolean
}

// ---------------------------------------------------------------------------
// Anthropic Messages response → OpenAI Chat Completions (response side)
// ---------------------------------------------------------------------------

export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export interface AnthropicMessagesResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >
  model: string
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null
  stop_sequence: string | null
  usage: AnthropicUsage
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions response shape
// ---------------------------------------------------------------------------

export interface OpenAIToolCallResult {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface OpenAIChatCompletionMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: OpenAIToolCallResult[]
}

export interface OpenAIChatCompletionChoice {
  index: number
  message: OpenAIChatCompletionMessage
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
}

export interface OpenAIChatCompletionResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: OpenAIChatCompletionChoice[]
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}
