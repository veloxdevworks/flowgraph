/** Ambient declarations for optional LangChain vendor peer dependencies. */

declare module "@langchain/openai" {
  export class ChatOpenAI {
    constructor(opts?: Record<string, unknown>);
  }
}

declare module "@langchain/anthropic" {
  export class ChatAnthropic {
    constructor(opts?: Record<string, unknown>);
  }
}

declare module "@langchain/xai" {
  export class ChatXAI {
    constructor(opts?: Record<string, unknown>);
  }
}

declare module "@langchain/ollama" {
  export class ChatOllama {
    constructor(opts?: Record<string, unknown>);
  }
}

declare module "@langchain/google-genai" {
  export class ChatGoogleGenerativeAI {
    constructor(opts?: Record<string, unknown>);
  }
}

declare module "@langchain/aws" {
  export class ChatBedrockConverse {
    constructor(opts?: Record<string, unknown>);
  }
}
