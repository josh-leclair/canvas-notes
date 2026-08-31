from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.config import settings
from app.errors import ApiError
from app.jobs import start_inline_worker
from app.routers import auth as auth_router
from app.routers import (
    canvases,
    cards,
    files,
    invites,
    links,
    placements,
    public_lenses,
    productivity,
    search,
    tokens,
    zones,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    stop = start_inline_worker() if settings.worker_inline else None
    yield
    if stop is not None:
        stop.set()


app = FastAPI(
    title=settings.instance_name, docs_url=None, redoc_url=None, lifespan=lifespan
)


@app.exception_handler(ApiError)
async def api_error_handler(request: Request, exc: ApiError):
    return JSONResponse(
        status_code=exc.status,
        content={"error": {"code": exc.code, "message": exc.message}},
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={"error": {"code": "validation_error", "message": str(exc.errors()[:3])}},
    )


app.include_router(auth_router.router)
app.include_router(invites.router)
app.include_router(canvases.router)
app.include_router(links.router)
app.include_router(cards.router)
app.include_router(placements.router)
app.include_router(public_lenses.router)
app.include_router(productivity.router)
app.include_router(files.router)
app.include_router(search.router)
app.include_router(tokens.router)
app.include_router(zones.router)
