import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-code";

export type OnMessage = (message: SDKMessage) => void | Promise<void>;

export type MessageGenerator = () => AsyncGenerator<
  SDKUserMessage,
  void,
  unknown
>;

const createPromise = <T>() => {
  let promiseResolve: ((value: T) => void) | undefined;
  let promiseReject: ((reason?: unknown) => void) | undefined;

  const promise = new Promise<T>((resolve, reject) => {
    promiseResolve = resolve;
    promiseReject = reject;
  });

  if (!promiseResolve || !promiseReject) {
    throw new Error("Illegal state: Promise not created");
  }

  return {
    promise,
    resolve: promiseResolve,
    reject: promiseReject,
  } as const;
};

export const createMessageGenerator = (
  firstMessage: string,
): {
  generateMessages: MessageGenerator;
  setNextMessage: (message: string) => void;
  setFirstMessagePromise: () => void;
  resolveFirstMessage: () => void;
  awaitFirstMessage: () => Promise<void>;
} => {
  let sendMessagePromise = createPromise<string>();
  let receivedFirstMessagePromise = createPromise<undefined>();

  const createMessage = (message: string): SDKUserMessage => {
    return {
      type: "user",
      message: {
        role: "user",
        content: message,
      },
    } as SDKUserMessage;
  };

  async function* generateMessages(): ReturnType<MessageGenerator> {
    yield createMessage(firstMessage);

    while (true) {
      const message = await sendMessagePromise.promise;
      sendMessagePromise = createPromise<string>();

      yield createMessage(message);
    }
  }

  const setNextMessage = (message: string) => {
    sendMessagePromise.resolve(message);
  };

  const setFirstMessagePromise = () => {
    receivedFirstMessagePromise = createPromise<undefined>();
  };

  const resolveFirstMessage = () => {
    receivedFirstMessagePromise.resolve(undefined);
  };

  const awaitFirstMessage = async () => {
    await receivedFirstMessagePromise.promise;
  };

  return {
    generateMessages,
    setNextMessage,
    setFirstMessagePromise,
    resolveFirstMessage,
    awaitFirstMessage,
  };
};
