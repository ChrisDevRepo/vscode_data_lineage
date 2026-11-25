import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessageChunk, BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { ModelIdentity } from '../../../../src/ai/model/modelPort';
import type { ProviderChat } from '../../../../src/ai/model/providerModelPort';

/** A chat model that streams the chunks it was given, as a provider's reply, and nothing else. */
class ScriptedChatModel extends BaseChatModel {
  public constructor(private readonly chunks: readonly AIMessageChunk[]) {
    super({});
  }

  public _llmType(): string {
    return 'scripted';
  }

  public async _generate(): Promise<ChatResult> {
    return { generations: [] };
  }

  public override async *_streamResponseChunks(_messages: BaseMessage[]): AsyncGenerator<ChatGenerationChunk> {
    for (const message of this.chunks) yield new ChatGenerationChunk({ message, text: typeof message.content === 'string' ? message.content : '' });
  }
}

const IDENTITY: ModelIdentity = { id: 'm', name: 'm', vendor: 'v', family: 'f', version: '1' };

/** The provider chat over `chunks`: one reply per generation, the request untouched. */
export function scriptedChat(chunks: readonly AIMessageChunk[], identity: ModelIdentity = IDENTITY): ProviderChat {
  return {
    id: 'test',
    identity,
    request: (messages) => ({ model: new ScriptedChatModel(chunks), messages: [...messages] }),
  };
}
