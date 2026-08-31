"""Dedicated worker process: python -m app.worker.

Runs the job queue and every configured capture bot. Bots live here rather
than in the API because they are long-lived outbound connections, and because
a restart of the API should not drop them.
"""
import logging
import signal
import threading

from app.bots.supervisor import start_bots
from app.jobs import worker_loop

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    stop = threading.Event()

    def _shutdown(*_args):
        stop.set()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    start_bots(stop)
    worker_loop(stop)
