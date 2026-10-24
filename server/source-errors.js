export class SourceError extends Error {
  constructor(code, status) {
    super("Дані джерела тимчасово недоступні");
    this.code = code;
    this.status = status;
  }
}
export function failureCode(error) {
  if (error instanceof SourceError) return error.code;
  if (error?.name === "TimeoutError" || error?.name === "AbortError")
    return "timeout";
  if (error instanceof SyntaxError) return "invalid_response";
  return "unreachable";
}
export const failureMessage = (code) =>
  ({
    timeout: "Сервіс Черкасиобленерго не відповів вчасно. Спробуємо пізніше.",
    forbidden: "Сервіс Черкасиобленерго відхилив запит. Спробуємо пізніше.",
    rate_limited: "Сервіс тимчасово обмежив запити. Спробуйте пізніше.",
    invalid_response:
      "Сервіс Черкасиобленерго повернув некоректні дані. Спробуємо пізніше.",
  })[code] || "Не вдалося оновити дані Черкасиобленерго. Спробуємо пізніше.";
