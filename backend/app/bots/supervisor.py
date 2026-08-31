"""Starts every configured bot adapter in its own thread."""
import logging
import threading

from app.bots import ADAPTERS

log = logging.getLogger("bots")


def start_bots(stop: threading.Event) -> list[threading.Thread]:
    threads: list[threading.Thread] = []
    for adapter_class in ADAPTERS:
        if not adapter_class.configured():
            log.info("%s bot not configured, skipping", adapter_class.platform)
            continue
        adapter = adapter_class()
        thread = threading.Thread(
            target=adapter.run, args=(stop,), daemon=True, name=f"bot-{adapter.platform}"
        )
        thread.start()
        threads.append(thread)
        log.info("%s bot started", adapter_class.platform)
    return threads
