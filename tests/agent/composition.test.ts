import { describe, expect, it, vi } from 'vitest';
import { cleanNote, judgeComposition } from '../../src/agent/composition.js';

function clientReturning(input: unknown) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [
          { type: 'text', text: 'ignored prose' },
          { type: 'tool_use', name: 'submit_verdict', id: 't1', input },
        ],
      }),
    },
  };
}

describe('cleanNote', () => {
  /**
   * 実測（2026-08-14, MiniMax-M3）：note に `</note>` だけが入って
   * 返ってきた。素のテキストで送るとそのまま画面に出る。
   */
  it('drops a stray closing tag the model emitted', () => {
    expect(cleanNote('</note>')).toBe('');
    expect(cleanNote('<note>助词错了</note>')).toBe('助词错了');
  });

  it('keeps a real note and tidies it', () => {
    expect(cleanNote('  **助词**用错了  ')).toBe('助词用错了');
    expect(cleanNote('第一行\n第二行')).toBe('第一行 第二行');
  });

  it('drops punctuation-only noise', () => {
    expect(cleanNote('---')).toBe('');
    expect(cleanNote('。。。')).toBe('');
  });
});

describe('judgeComposition', () => {
  it('reads the verdict out of the forced tool call', async () => {
    const client = clientReturning({ ok: true, note: '更自然的说法是……' });
    const verdict = await judgeComposition(
      { meaning: '你好', reference: 'こんにちは。', written: 'こんにちは' },
      { client, model: 'test-model' },
    );
    expect(verdict).toEqual({ ok: true, note: '更自然的说法是……' });
  });

  it('cleans the note before handing it back', async () => {
    const client = clientReturning({ ok: false, note: '</note>' });
    const verdict = await judgeComposition(
      { meaning: '你好', reference: 'こんにちは。', written: 'x' },
      { client, model: 'test-model' },
    );
    expect(verdict).toEqual({ ok: false, note: '' });
  });

  it('gives up rather than guessing when the model does not call the tool', async () => {
    const client = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'ok I think it is fine' }],
        }),
      },
    };
    expect(
      await judgeComposition(
        { meaning: '你好', reference: 'こんにちは。', written: 'x' },
        { client, model: 'test-model' },
      ),
    ).toBeUndefined();
  });

  it('gives up when the payload does not match the schema', async () => {
    const client = clientReturning({ ok: 'yes' });
    expect(
      await judgeComposition(
        { meaning: '你好', reference: 'こんにちは。', written: 'x' },
        { client, model: 'test-model' },
      ),
    ).toBeUndefined();
  });

  it('gives up when the request fails', async () => {
    const client = {
      messages: { create: vi.fn().mockRejectedValue(new Error('boom')) },
    };
    expect(
      await judgeComposition(
        { meaning: '你好', reference: 'こんにちは。', written: 'x' },
        { client, model: 'test-model' },
      ),
    ).toBeUndefined();
  });

  it('passes the human-written reference so the model never invents one', async () => {
    const client = clientReturning({ ok: true, note: '' });
    await judgeComposition(
      {
        meaning: '我买了红色领带。',
        reference: '赤いネクタイを買いました。',
        written: '赤いネクタイを買った。',
      },
      { client, model: 'test-model' },
    );
    const call = client.messages.create.mock.calls[0]?.[0] as {
      messages: { content: string }[];
      tool_choice: unknown;
    };
    expect(call.messages[0]?.content).toContain('赤いネクタイを買いました。');
    expect(call.tool_choice).toEqual({ type: 'tool', name: 'submit_verdict' });
  });
});

describe('送信が詰まったとき', () => {
  /**
   * 実測：240 件を 5 並列で投げると 3 分の 1 が返らなかった。同じ入力を
   * 単発で投げ直すと 4 秒で返ったので、原因は判定の失敗ではなく詰まり。
   * 並列を 2 に落として一度だけ再試行したら、判定不能は 60 → 6 に減った。
   */
  it('retries once and succeeds', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('429 rate limited'))
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', name: 'submit_verdict', id: 't', input: { ok: true, note: '' } },
        ],
      });
    const verdict = await judgeComposition(
      { meaning: '你好', reference: 'こんにちは。', written: 'こんにちは' },
      { client: { messages: { create } }, model: 'test-model' },
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(verdict).toEqual({ ok: true, note: '' });
  });

  it('gives up after the second failure rather than hanging on', async () => {
    const create = vi.fn().mockRejectedValue(new Error('down'));
    const seen: boolean[] = [];
    const verdict = await judgeComposition(
      { meaning: '你好', reference: 'こんにちは。', written: 'x' },
      {
        client: { messages: { create } },
        model: 'test-model',
        onError: (_error, willRetry) => seen.push(willRetry),
      },
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([true, false]);
    expect(verdict).toBeUndefined();
  });

  it('does not retry when the caller turns it off', async () => {
    const create = vi.fn().mockRejectedValue(new Error('down'));
    await judgeComposition(
      { meaning: '你好', reference: 'こんにちは。', written: 'x' },
      { client: { messages: { create } }, model: 'test-model', retry: false },
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  /** 判定が返ってきた場合は投げ直さない。 */
  it('never retries a successful call', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [
        { type: 'tool_use', name: 'submit_verdict', id: 't', input: { ok: false, note: 'x' } },
      ],
    });
    await judgeComposition(
      { meaning: '你好', reference: 'こんにちは。', written: 'x' },
      { client: { messages: { create } }, model: 'test-model' },
    );
    expect(create).toHaveBeenCalledTimes(1);
  });
});
