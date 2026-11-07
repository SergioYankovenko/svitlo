package ua.svitlo.widget

import java.io.IOException
import java.net.SocketTimeoutException

enum class SourceFailure(val messageText:String) {
    OFFLINE("Немає підключення до інтернету"),
    TIMEOUT("Сервіс Черкасиобленерго не відповів вчасно. Спробуємо пізніше"),
    FORBIDDEN("Сервіс Черкасиобленерго відхилив запит. Спробуємо пізніше"),
    RATE_LIMITED("Сервіс тимчасово обмежив запити. Спробуйте пізніше"),
    SERVER("Сервіс Черкасиобленерго тимчасово недоступний. Спробуємо пізніше"),
    INVALID("Сервіс Черкасиобленерго повернув некоректні дані. Спробуємо пізніше"),
    UNREACHABLE("Не вдалося оновити дані Черкасиобленерго. Спробуємо пізніше");
    companion object {
        fun of(error:Throwable):SourceFailure = when(error){
            is SourceException -> error.failure
            is SocketTimeoutException -> TIMEOUT
            is IllegalArgumentException, is org.json.JSONException -> INVALID
            else -> UNREACHABLE
        }
        fun http(status:Int)=when(status){403->FORBIDDEN;429->RATE_LIMITED;in 500..599->SERVER;else->UNREACHABLE}
    }
}
/** No request URL, response body or personal account is retained in the exception. */
class SourceException(val failure:SourceFailure):IOException(failure.messageText)
