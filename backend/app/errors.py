class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status = status
        self.code = code
        self.message = message


def not_found() -> ApiError:
    # Rows owned by someone else 404 rather than 403: a 403 confirms existence.
    return ApiError(404, "not_found", "Not found")
