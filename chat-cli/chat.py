#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Pure OpenAI Chat (CMD)
零依赖、纯净调用标准 OpenAI Chat Completions 接口 (/chat/completions)
可选对接无头记忆卡带协议（assemble / commit），前端本身零记忆逻辑、零提示词拼装。
"""

import argparse
import ctypes
import datetime
import json
import os
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

# ==================== 配置区（直接修改这里即可） ====================
API_BASE = "https://api.openai.com/v1"   # 标准 OpenAI 接口地址（兼容任意 OpenAI 格式中转/本地服务）
API_KEY = "sk-your-api-key-here"         # API Key（留空或保持占位符时自动尝试读取环境变量 OPENAI_API_KEY）
MODEL = "gpt-4o-mini"                    # 模型名称

SYSTEM_PROMPT = ""                       # 纯裸调模式下的系统提示词；接入卡带时由卡带全权接管
STREAM = True                            # True: 流式逐字输出 | False: 等待完整返回
TEMPERATURE = None                       # 采样温度（如 0.7）；None 表示不发送该字段
MAX_TOKENS = None                        # 最大输出 token；None 表示不发送该字段
TIMEOUT = 120                            # 请求超时时间（秒）
SHOW_REASONING = True                    # 若模型返回 reasoning_content，是否灰字展示（绝不写入对话历史）
PROXY = ""                               # 手动代理，如 "http://127.0.0.1:7890"；留空跟随系统代理（localhost 自动直连）

# --- 可选：无头记忆卡带协议（先运行根目录 start-cassette.bat 或 npm run serve） ---
CASSETTE_URL = "http://127.0.0.1:3891"   # 无头卡带服务地址（不经手 OpenAI API Key）
CASSETTE_ID = ""                         # 留空=纯裸调模式；填 "starter" 或你自建的卡带 ID 则接入卡带拼装上下文
CASSETTE_SEND_HISTORY = True             # True=模拟自带历史前端；False=模拟无状态哑前端(不传history，由卡带补足10轮)
CASSETTE_COMMIT = False                  # True=对话后写回卡带账本（根目录 start-chat.bat 默认开启 --commit）
# ====================================================================


def setup_console() -> bool:
    """配置 Windows CMD 的 UTF-8 与 ANSI 颜色支持。"""
    if not sys.stdin.isatty() and hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")

    if not sys.stdout.isatty():
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        if hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        return False

    if os.name == "nt":
        try:
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
            mode = ctypes.c_uint32()
            if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
                if kernel32.SetConsoleMode(handle, mode.value | 0x0004):
                    return True
        except Exception:
            return False
        return False
    return True


USE_COLOR = setup_console()


def colorize(text: str, code: str) -> str:
    if not USE_COLOR:
        return text
    return f"\033[{code}m{text}\033[0m"


def dim(text: str) -> str:
    return colorize(text, "90")


def cyan(text: str) -> str:
    return colorize(text, "36")


def green(text: str) -> str:
    return colorize(text, "32")


def yellow(text: str) -> str:
    return colorize(text, "33")


def red(text: str) -> str:
    return colorize(text, "31")


def mask_key(key: str) -> str:
    if not key:
        return "(未设置)"
    if len(key) <= 10:
        return "*" * len(key)
    return f"{key[:6]}...{key[-4:]}"


def build_chat_url(api_base: str) -> str:
    """写死拼接标准 OpenAI /chat/completions 端点。"""
    base = api_base.strip().rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return f"{base}/chat/completions"


def build_opener(url: str, proxy: str) -> urllib.request.OpenerDirector:
    if proxy.strip():
        p = proxy.strip()
        return urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": p, "https": p})
        )
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    if host in ("127.0.0.1", "localhost", "::1"):
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener()


def post_cassette_json(cassette_url: str, path_suffix: str, payload: dict, timeout: int = 30) -> dict | None:
    """调用本地无头卡带协议（assemble / commit），自动绕过系统代理。"""
    url = f"{cassette_url.strip().rstrip('/')}{path_suffix}"
    body_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body_bytes,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "pure-openai-chat/1.0",
        },
        method="POST",
    )
    opener = build_opener(url, "")
    try:
        with opener.open(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        err_text = ""
        try:
            err_text = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        print(red(f"[卡带协议 HTTP {e.code}] {err_text or e.reason}"))
        return None
    except Exception as e:
        print(red(f"[卡带连接失败] {url} -> {e}"))
        print(dim("提示：请先启动卡带无头服务（根目录 start-cassette.bat 或 npm run serve）"))
        return None


def build_openai_payload(
    model: str,
    req_messages: list[dict],
    stream: bool,
    temperature: float | None,
    max_tokens: int | None,
) -> dict:
    payload: dict = {
        "model": model,
        "messages": req_messages,
        "stream": stream,
    }
    if temperature is not None:
        payload["temperature"] = temperature
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    return payload


def format_usage(usage: dict | None) -> str:
    if not isinstance(usage, dict):
        return ""
    prompt_t = usage.get("prompt_tokens")
    comp_t = usage.get("completion_tokens")
    total_t = usage.get("total_tokens")
    parts = []
    if prompt_t is not None:
        parts.append(f"in={prompt_t}")
    if comp_t is not None:
        parts.append(f"out={comp_t}")
    if total_t is not None:
        parts.append(f"total={total_t}")
    return f"[tokens: {' '.join(parts)}]" if parts else ""


def parse_non_stream_body(body_text: str, raw_mode: bool, show_reasoning: bool) -> str:
    if raw_mode:
        try:
            pretty = json.dumps(json.loads(body_text), ensure_ascii=False, indent=2)
        except Exception:
            pretty = body_text
        print(dim(f"[RAW RES]\n{pretty}"))

    data = json.loads(body_text)
    if "error" in data and data["error"]:
        raise RuntimeError(json.dumps(data["error"], ensure_ascii=False))

    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError(f"响应中无 choices 字段: {body_text[:300]}")

    msg = choices[0].get("message") or {}
    reasoning = msg.get("reasoning_content") or msg.get("reasoning") or ""
    content = msg.get("content") or ""

    if show_reasoning and reasoning:
        print(dim(f"[思考] {reasoning}"))

    print(f"{green('AI > ')}{content}")

    usage_str = format_usage(data.get("usage"))
    if usage_str:
        print(dim(usage_str))
    return content


def call_openai_chat(
    api_base: str,
    api_key: str,
    model: str,
    req_messages: list[dict],
    stream: bool,
    temperature: float | None,
    max_tokens: int | None,
    timeout: int,
    show_reasoning: bool,
    proxy: str,
    raw_mode: bool,
) -> str | None:
    """发送纯净标准 OpenAI Chat Completions 请求。成功返回 assistant 文本；失败或中断返回 None。"""
    url = build_chat_url(api_base)
    payload = build_openai_payload(
        model=model,
        req_messages=req_messages,
        stream=stream,
        temperature=temperature,
        max_tokens=max_tokens,
    )
    body_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    if raw_mode:
        print(dim(f"[RAW REQ] POST {url}"))
        print(dim(json.dumps(payload, ensure_ascii=False, indent=2)))

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "Accept": "text/event-stream" if stream else "application/json",
        "User-Agent": "pure-openai-chat/1.0",
    }
    req = urllib.request.Request(url, data=body_bytes, headers=headers, method="POST")
    opener = build_opener(url, proxy)

    try:
        with opener.open(req, timeout=timeout) as resp:
            content_type = (resp.headers.get("Content-Type") or "").lower()

            if (not stream) or (
                "application/json" in content_type
                and "text/event-stream" not in content_type
            ):
                body_text = resp.read().decode("utf-8", errors="replace")
                return parse_non_stream_body(body_text, raw_mode, show_reasoning)

            content_parts: list[str] = []
            usage_info: dict | None = None
            in_reasoning = False
            started_answer = False

            while True:
                raw_line = resp.readline()
                if not raw_line:
                    break
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line or line.startswith(":"):
                    continue
                if not line.startswith("data:"):
                    continue

                data_str = line[5:].strip()
                if data_str == "[DONE]":
                    break

                if raw_mode:
                    print(dim(f"\n[RAW SSE] {data_str}"))

                try:
                    chunk = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                if "error" in chunk and chunk["error"]:
                    if in_reasoning or started_answer:
                        print()
                    print(
                        red(
                            f"[API 错误] {json.dumps(chunk['error'], ensure_ascii=False)}"
                        )
                    )
                    return None

                if chunk.get("usage"):
                    usage_info = chunk["usage"]

                choices = chunk.get("choices") or []
                if not choices:
                    continue

                delta = choices[0].get("delta") or {}
                reasoning = delta.get("reasoning_content") or delta.get("reasoning") or ""
                text = delta.get("content") or ""

                if show_reasoning and reasoning:
                    if not in_reasoning:
                        print(dim("[思考] "), end="", flush=True)
                        in_reasoning = True
                    print(dim(reasoning), end="", flush=True)

                if text:
                    if not started_answer:
                        if in_reasoning:
                            print()
                            in_reasoning = False
                        print(green("AI > "), end="", flush=True)
                        started_answer = True
                    print(text, end="", flush=True)
                    content_parts.append(text)

            if in_reasoning or started_answer:
                print()
            else:
                print(green("AI > ") + dim("(空响应)"))

            usage_str = format_usage(usage_info)
            if usage_str:
                print(dim(usage_str))

            return "".join(content_parts)

    except KeyboardInterrupt:
        print(yellow("\n[已中断生成，本轮未写入历史]"))
        return None
    except urllib.error.HTTPError as e:
        err_body = ""
        try:
            err_body = e.read().decode("utf-8", errors="replace")
            try:
                err_body = json.dumps(json.loads(err_body), ensure_ascii=False, indent=2)
            except Exception:
                pass
        except Exception:
            pass
        print(red(f"[HTTP {e.code} 错误] {e.reason}"))
        if err_body:
            print(red(err_body))
        return None
    except (TimeoutError, socket.timeout):
        print(red(f"[请求超时] 超过 {timeout} 秒未收到响应"))
        return None
    except urllib.error.URLError as e:
        print(red(f"[网络错误] {e.reason}"))
        return None
    except Exception as e:
        print(red(f"[异常] {e}"))
        return None


def print_banner(
    api_base: str,
    api_key: str,
    model: str,
    stream: bool,
    system_prompt: str,
    cassette_id: str,
    cassette_url: str,
    cassette_send_history: bool,
    cassette_commit: bool,
    session_id: str,
) -> None:
    print(dim("=" * 64))
    print(cyan("  Pure OpenAI Chat (CMD)"))
    print(dim(f"  Endpoint : {build_chat_url(api_base)}"))
    print(dim(f"  Model    : {model}"))
    print(dim(f"  Key      : {mask_key(api_key)}"))
    print(dim(f"  Stream   : {'ON' if stream else 'OFF'}"))
    if cassette_id:
        h_mode = "自带history" if cassette_send_history else "无状态(卡带补10轮)"
        c_mode = "ON" if cassette_commit else "OFF"
        print(
            dim(
                f"  Cassette : {cassette_id} @ {cassette_url} ({h_mode} | commit={c_mode})"
            )
        )
        print(dim(f"  Session  : {session_id}"))
    else:
        sys_desc = (
            system_prompt[:40] + ("..." if len(system_prompt) > 40 else "")
            if system_prompt
            else "(无，纯裸调)"
        )
        print(dim(f"  Cassette : OFF（纯裸调模式） | System: {sys_desc}"))
    print(dim("  命令     : /help 查看帮助 | /cassette 切卡带 | /raw 看原始包 | /exit 退出"))
    print(dim("=" * 64))


def print_help() -> None:
    help_text = """可用命令:
  /help                  显示帮助
  /clear                 清空前端本地对话历史
  /history               查看前端本地消息列表
  /undo                  撤回前端最后一轮对话
  /retry                 重新生成最后一条回复
  /model [模型名]        查看或临时切换模型
  /base [URL]            查看或临时切换 API_BASE
  /key [API_KEY]         查看(脱敏)或临时切换 API_KEY
  /system [内容|clear]   查看、设置或清空裸调模式下的 system prompt
  /stream                切换流式/非流式输出
  /raw                   开关原始请求/响应调试打印（可直接验卡带拼装结果）
  /cassette [id|off]     接入或关闭记忆卡带（如 /cassette starter 或 /cassette off）
  /historymode           切换“自带history前端”与“无状态哑前端(不传history)”
  /commit                切换对话结束后是否写回卡带账本（ON/OFF）
  /session [id]          查看或切换当前 sessionId（模拟新开会话窗口）
  /ml                    进入多行输入模式（单独一行输入 /end 发送）
  /save [文件名]         导出前端本地对话记录到 logs/ 目录
  /exit 或 /quit         退出程序"""
    print(dim(help_text))


def read_multiline() -> str | None:
    print(dim("进入多行输入模式：单独一行输入 /end 发送，输入 /cancel 取消"))
    lines: list[str] = []
    while True:
        try:
            line = input(dim("... "))
        except (EOFError, KeyboardInterrupt):
            print()
            return None
        stripped = line.strip()
        if stripped == "/end":
            return "\n".join(lines)
        if stripped == "/cancel":
            print(yellow("[已取消多行输入]"))
            return None
        lines.append(line)


def save_history(messages: list[dict], system_prompt: str, model: str, custom_name: str) -> None:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    logs_dir = os.path.join(base_dir, "logs")
    os.makedirs(logs_dir, exist_ok=True)

    if custom_name:
        filename = custom_name if custom_name.endswith(".json") else f"{custom_name}.json"
        filename = os.path.basename(filename)
    else:
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"chat_{ts}.json"

    filepath = os.path.join(logs_dir, filename)
    record = {
        "saved_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "model": model,
        "system": system_prompt,
        "messages": messages,
    }
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)
    print(dim(f"[已保存] {filepath}"))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Pure OpenAI Chat (CMD)")
    parser.add_argument("--base", default=None, help="覆盖 API_BASE")
    parser.add_argument("--key", default=None, help="覆盖 API_KEY")
    parser.add_argument("--model", default=None, help="覆盖 MODEL")
    parser.add_argument("--system", default=None, help="覆盖 SYSTEM_PROMPT")
    parser.add_argument("--no-stream", action="store_true", help="关闭流式输出")
    parser.add_argument("--raw", action="store_true", help="开启原始请求/响应打印")
    parser.add_argument("--cassette", default=None, help="接入卡带 ID（如 starter）")
    parser.add_argument("--cassette-url", default=None, help="覆盖无头卡带服务地址")
    parser.add_argument("--stateless", action="store_true", help="无状态模式：前端不传 history，全由卡带补齐")
    parser.add_argument("--commit", action="store_true", help="开启对话结束后写回卡带账本")
    parser.add_argument("--session", default=None, help="指定 sessionId")
    return parser.parse_args()


def resolve_initial_key(cli_key: str | None) -> str:
    if cli_key:
        return cli_key.strip()
    if API_KEY and API_KEY != "sk-your-api-key-here":
        return API_KEY.strip()
    env_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if env_key:
        return env_key
    return ""


def send_turn(
    *,
    user_text: str,
    local_messages: list[dict],
    api_base: str,
    api_key: str,
    model: str,
    system_prompt: str,
    stream: bool,
    temperature: float | None,
    max_tokens: int | None,
    timeout: int,
    show_reasoning: bool,
    proxy: str,
    raw_mode: bool,
    cassette_id: str,
    cassette_url: str,
    cassette_send_history: bool,
    cassette_commit: bool,
    session_id: str,
) -> str | None:
    """执行一轮对话：卡带模式走 assemble->OpenAI->commit，纯裸调直接发 OpenAI。"""
    if cassette_id:
        req_body: dict = {
            "sessionId": session_id,
            "userText": user_text,
            "model": model,
        }
        if cassette_send_history:
            req_body["history"] = local_messages

        assembled = post_cassette_json(
            cassette_url,
            f"/cartridges/{urllib.parse.quote(cassette_id)}/assemble",
            req_body,
            timeout=timeout,
        )
        if not assembled or not isinstance(assembled.get("messages"), list):
            return None

        meta = assembled.get("meta") or {}
        h_meta = meta.get("history") or {}
        r_meta = meta.get("recall") or {}
        b_meta = meta.get("board_update") or {}
        if b_meta.get("baseline_initialized"):
            board_desc = "开局冻结"
        elif b_meta.get("has_update"):
            delta_parts = []
            if b_meta.get("timeline_added"):
                delta_parts.append(f"+{b_meta['timeline_added']}脉络")
            if b_meta.get("evergreen_added"):
                delta_parts.append(f"+{b_meta['evergreen_added']}常青")
            if b_meta.get("soul_changed"):
                delta_parts.append("SOUL")
            if b_meta.get("profile_changed"):
                delta_parts.append("画像")
            board_desc = f"热更新({' '.join(delta_parts)})"
        else:
            board_desc = "无变更"
        print(
            dim(
                f"[卡带 {meta.get('cartridge_id') or cassette_id} | "
                f"历史: 前端{h_meta.get('frontend_turns', 0)}+补齐{h_meta.get('backfilled_turns', 0)}"
                f"={h_meta.get('effective_turns', 0)}轮({h_meta.get('action', '-')}) | "
                f"召回: {r_meta.get('mode', '-')} {r_meta.get('count', 0)}条 | "
                f"信息板: {board_desc}]"
            )
        )
        req_messages = assembled["messages"]
    else:
        req_messages = []
        if system_prompt:
            req_messages.append({"role": "system", "content": system_prompt})
        req_messages.extend(local_messages)
        req_messages.append({"role": "user", "content": user_text})

    reply = call_openai_chat(
        api_base=api_base,
        api_key=api_key,
        model=model,
        req_messages=req_messages,
        stream=stream,
        temperature=temperature,
        max_tokens=max_tokens,
        timeout=timeout,
        show_reasoning=show_reasoning,
        proxy=proxy,
        raw_mode=raw_mode,
    )
    if reply is None:
        return None

    if cassette_id and cassette_commit:
        committed = post_cassette_json(
            cassette_url,
            f"/cartridges/{urllib.parse.quote(cassette_id)}/commit",
            {
                "sessionId": session_id,
                "userText": user_text,
                "assistantText": reply,
                "model": model,
                "harness": "pure-chat",
            },
            timeout=30,
        )
        if committed and committed.get("ok"):
            dream_flag = " | dream_due!" if committed.get("dream_due") else ""
            print(dim(f"[已写回账本 +{committed.get('added', 0)}{dream_flag}]"))

    return reply


def main() -> None:
    args = parse_args()

    api_base = (args.base or API_BASE).strip()
    api_key = resolve_initial_key(args.key)
    model = (args.model or MODEL).strip()
    system_prompt = SYSTEM_PROMPT if args.system is None else args.system
    stream = False if args.no_stream else STREAM
    temperature = TEMPERATURE
    max_tokens = MAX_TOKENS
    timeout = TIMEOUT
    show_reasoning = SHOW_REASONING
    proxy = PROXY
    raw_mode = args.raw

    cassette_url = (args.cassette_url or CASSETTE_URL).strip()
    cassette_id = (args.cassette if args.cassette is not None else CASSETTE_ID).strip()
    cassette_send_history = False if args.stateless else CASSETTE_SEND_HISTORY
    cassette_commit = True if args.commit else CASSETTE_COMMIT
    session_id = (
        args.session.strip()
        if args.session
        else f"p{uuid.uuid4().hex[:7]}-{datetime.datetime.now().strftime('%H%M%S')}"
    )

    if not api_key:
        print(yellow("检测到尚未配置 API_KEY（可在 chat.py 顶部写死，或设置环境变量 OPENAI_API_KEY）。"))
        try:
            entered = input("请临时输入 API Key（直接回车退出）: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not entered:
            return
        api_key = entered

    messages: list[dict] = []
    last_user_text = ""

    print_banner(
        api_base,
        api_key,
        model,
        stream,
        system_prompt,
        cassette_id,
        cassette_url,
        cassette_send_history,
        cassette_commit,
        session_id,
    )

    while True:
        try:
            user_input = input(f"\n{cyan('You > ')}").strip()
        except (EOFError, KeyboardInterrupt):
            print(dim("\nBye."))
            break

        if not user_input:
            continue

        if user_input.startswith("/"):
            parts = user_input.split(maxsplit=1)
            cmd = parts[0].lower()
            arg = parts[1].strip() if len(parts) > 1 else ""

            if cmd in ("/exit", "/quit", "/q"):
                print(dim("Bye."))
                break
            if cmd == "/help":
                print_help()
                continue
            if cmd == "/clear":
                messages.clear()
                print(dim("[已清空前端本地历史]"))
                continue
            if cmd == "/history":
                if not messages:
                    print(dim("[前端本地无对话历史]"))
                else:
                    print(dim(f"[前端本地共 {len(messages)} 条消息]"))
                    for idx, m in enumerate(messages, 1):
                        preview = m["content"].replace("\n", " ")
                        if len(preview) > 80:
                            preview = preview[:80] + "..."
                        print(dim(f"  {idx}. [{m['role']}] {preview}"))
                continue
            if cmd == "/undo":
                if not messages:
                    print(dim("[无记录可撤回]"))
                else:
                    if messages and messages[-1]["role"] == "assistant":
                        messages.pop()
                    if messages and messages[-1]["role"] == "user":
                        messages.pop()
                    print(dim(f"[已撤回上一轮，前端剩余 {len(messages)} 条消息]"))
                continue
            if cmd == "/retry":
                retry_text = ""
                saved_pair: list[dict] = []
                if messages:
                    if messages[-1]["role"] == "assistant":
                        saved_pair.insert(0, messages.pop())
                    if messages and messages[-1]["role"] == "user":
                        u_msg = messages.pop()
                        saved_pair.insert(0, u_msg)
                        retry_text = u_msg["content"]
                elif last_user_text:
                    retry_text = last_user_text

                if not retry_text:
                    messages.extend(saved_pair)
                    print(dim("[找不到可重试的用户消息]"))
                    continue

                reply = send_turn(
                    user_text=retry_text,
                    local_messages=messages,
                    api_base=api_base,
                    api_key=api_key,
                    model=model,
                    system_prompt=system_prompt,
                    stream=stream,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    timeout=timeout,
                    show_reasoning=show_reasoning,
                    proxy=proxy,
                    raw_mode=raw_mode,
                    cassette_id=cassette_id,
                    cassette_url=cassette_url,
                    cassette_send_history=cassette_send_history,
                    cassette_commit=cassette_commit,
                    session_id=session_id,
                )
                if reply is not None:
                    if (not cassette_id) or cassette_send_history:
                        messages.append({"role": "user", "content": retry_text})
                        messages.append({"role": "assistant", "content": reply})
                else:
                    messages.extend(saved_pair)
                continue
            if cmd == "/model":
                if arg:
                    model = arg
                    print(dim(f"[已切换模型] {model}"))
                else:
                    print(dim(f"[当前模型] {model}"))
                continue
            if cmd == "/base":
                if arg:
                    api_base = arg
                    print(dim(f"[已切换接口] {build_chat_url(api_base)}"))
                else:
                    print(dim(f"[当前接口] {build_chat_url(api_base)}"))
                continue
            if cmd == "/key":
                if arg:
                    api_key = arg
                    print(dim(f"[已更新 Key] {mask_key(api_key)}"))
                else:
                    print(dim(f"[当前 Key] {mask_key(api_key)}"))
                continue
            if cmd == "/system":
                if not arg:
                    print(dim(f"[当前 System] {system_prompt or '(无)'}"))
                elif arg.lower() == "clear":
                    system_prompt = ""
                    print(dim("[已清空 System Prompt]"))
                else:
                    system_prompt = arg
                    print(dim(f"[已设置 System] {system_prompt}"))
                continue
            if cmd == "/stream":
                stream = not stream
                print(dim(f"[流式输出] {'ON' if stream else 'OFF'}"))
                continue
            if cmd == "/raw":
                raw_mode = not raw_mode
                print(dim(f"[原始调试输出] {'ON' if raw_mode else 'OFF'}"))
                continue
            if cmd == "/cassette":
                if not arg:
                    print(dim(f"[当前卡带] {cassette_id or 'OFF（纯裸调）'} @ {cassette_url}"))
                elif arg.lower() in ("off", "none", "clear"):
                    cassette_id = ""
                    print(dim("[已断开卡带，切回纯裸调模式]"))
                else:
                    cassette_id = arg
                    print(dim(f"[已接入卡带] {cassette_id} @ {cassette_url}"))
                continue
            if cmd == "/historymode":
                cassette_send_history = not cassette_send_history
                mode_label = "前端自带 history" if cassette_send_history else "无状态哑前端（不传 history，由卡带补足10轮）"
                print(dim(f"[历史模式] {mode_label}"))
                continue
            if cmd == "/commit":
                cassette_commit = not cassette_commit
                print(dim(f"[写回卡带账本] {'ON' if cassette_commit else 'OFF'}"))
                continue
            if cmd == "/session":
                if arg:
                    session_id = arg
                    print(dim(f"[已切换 Session] {session_id}"))
                else:
                    print(dim(f"[当前 Session] {session_id}"))
                continue
            if cmd == "/save":
                try:
                    save_history(messages, system_prompt, model, arg)
                except Exception as e:
                    print(red(f"[保存失败] {e}"))
                continue
            if cmd == "/ml":
                ml_text = read_multiline()
                if not ml_text or not ml_text.strip():
                    continue
                user_input = ml_text
            else:
                print(yellow(f"未知命令: {cmd}（输入 /help 查看命令列表）"))
                continue

        last_user_text = user_input
        reply = send_turn(
            user_text=user_input,
            local_messages=messages,
            api_base=api_base,
            api_key=api_key,
            model=model,
            system_prompt=system_prompt,
            stream=stream,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
            show_reasoning=show_reasoning,
            proxy=proxy,
            raw_mode=raw_mode,
            cassette_id=cassette_id,
            cassette_url=cassette_url,
            cassette_send_history=cassette_send_history,
            cassette_commit=cassette_commit,
            session_id=session_id,
        )
        if reply is not None:
            if (not cassette_id) or cassette_send_history:
                messages.append({"role": "user", "content": user_input})
                messages.append({"role": "assistant", "content": reply})


if __name__ == "__main__":
    main()
