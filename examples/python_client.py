"""企业项目对接示例（Python 3.9+，依赖 requests）

用法:
    export KB_BASE_URL=http://127.0.0.1:7300
    export KB_API_KEY=kb_live_xxx
    python examples/python_client.py "怎么申请发票"
"""

from __future__ import annotations

import os
import time
from typing import Any, Dict, List, Optional

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


class KbClient:
    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout: int = 30,
    ) -> None:
        self.base_url = (base_url or os.environ.get("KB_BASE_URL", "http://127.0.0.1:7300")).rstrip("/")
        self.api_key = api_key or os.environ.get("KB_API_KEY", "")
        if not self.api_key:
            raise ValueError("缺少 KB_API_KEY")

        self.session = requests.Session()
        self.session.headers.update(
            {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            }
        )
        # 对 429 与 5xx 自动指数退避，读请求安全
        retry = Retry(
            total=2,
            backoff_factor=0.5,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset(["GET", "POST"]),
            respect_retry_after_header=True,
        )
        self.session.mount("http://", HTTPAdapter(max_retries=retry))
        self.session.mount("https://", HTTPAdapter(max_retries=retry))
        self.timeout = timeout

    def _call(self, method: str, path: str, **kwargs) -> Dict[str, Any]:
        resp = self.session.request(method, f"{self.base_url}{path}", timeout=self.timeout, **kwargs)
        if resp.status_code >= 400:
            try:
                payload = resp.json()
                msg = payload.get("error", {}).get("message", resp.text)
                code = payload.get("error", {}).get("code")
            except ValueError:
                msg, code = resp.text[:200], None
            raise KbError(msg, status=resp.status_code, code=code, request_id=resp.headers.get("x-request-id"))
        return resp.json()

    def search(self, query: str, space_id: Optional[str] = None, top_k: int = 8,
               tags: Optional[List[str]] = None) -> Dict[str, Any]:
        body: Dict[str, Any] = {"query": query, "top_k": top_k}
        if space_id:
            body["space_id"] = space_id
        if tags:
            body["tags"] = tags
        return self._call("POST", "/v1/search", json=body)

    def ask(self, query: str, space_id: Optional[str] = None, top_k: Optional[int] = None) -> Dict[str, Any]:
        body: Dict[str, Any] = {"query": query}
        if space_id:
            body["space_id"] = space_id
        if top_k:
            body["top_k"] = top_k
        return self._call("POST", "/v1/ask", json=body)

    def ingest(self, title: str, content: str, space: Optional[str] = None,
               tags: Optional[List[str]] = None, source_uri: Optional[str] = None) -> Dict[str, Any]:
        body: Dict[str, Any] = {"title": title, "content": content}
        if space:
            body["space"] = space
        if tags:
            body["tags"] = tags
        if source_uri:
            body["source_uri"] = source_uri
        return self._call("POST", "/v1/documents", json=body)

    def ingest_file(self, path: str, space: Optional[str] = None,
                    tags: Optional[List[str]] = None) -> Dict[str, Any]:
        import base64
        import os.path as osp

        with open(path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        body: Dict[str, Any] = {"filename": osp.basename(path), "file_base64": b64}
        if space:
            body["space"] = space
        if tags:
            body["tags"] = tags
        return self._call("POST", "/v1/documents", json=body)

    def list_documents(self, limit: int = 20, offset: int = 0, space_id: Optional[str] = None) -> Dict[str, Any]:
        params: Dict[str, Any] = {"limit": limit, "offset": offset}
        if space_id:
            params["space_id"] = space_id
        return self._call("GET", "/v1/documents", params=params)

    def meta(self) -> Dict[str, Any]:
        return self._call("GET", "/v1/meta")


class KbError(Exception):
    def __init__(self, message: str, status: int = 0, code: Optional[str] = None,
                 request_id: Optional[str] = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.request_id = request_id


def answer_customer_question(question: str) -> Dict[str, Any]:
    """接入客服系统的典型用法：按 mode 决定怎么展示，避免无依据的答案"""
    kb = KbClient()
    r = kb.ask(question)
    mode = r.get("mode")

    if mode in ("faq", "llm"):
        return {"reply": r["answer"], "sources": r.get("citations", []), "confident": True}

    if mode == "extractive":
        return {
            "reply": f"（以下为知识库原文摘录）\n{r['answer']}",
            "sources": r.get("citations", []),
            "confident": r.get("confidence", 0) > 0.6,
        }

    return {
        "reply": "这个问题知识库暂未收录，已为你转接人工客服。",
        "sources": [],
        "confident": False,
        "need_human": True,
    }


if __name__ == "__main__":
    import sys

    q = " ".join(sys.argv[1:]) or "知识库能做什么"
    try:
        out = answer_customer_question(q)
        print()
        print(out["reply"])
        if out["sources"]:
            print("\n来源：")
            for c in out["sources"]:
                head = f" / {c['heading']}" if c.get("heading") else ""
                print(f"  {c['index']}. 《{c['doc_title']}》{head}")
        if out.get("need_human"):
            print("（需转人工）")
    except KbError as e:
        print(f"调用失败: {e} (status={e.status}, request_id={e.request_id})")
        sys.exit(1)
