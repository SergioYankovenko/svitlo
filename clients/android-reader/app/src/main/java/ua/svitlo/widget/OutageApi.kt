package ua.svitlo.widget

import android.content.Context
import ua.svitlo.widget.core.AccountNumber
import ua.svitlo.widget.core.Category
import java.io.IOException
import java.io.Reader
import java.net.URL
import java.net.URLEncoder
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale
import javax.net.ssl.HttpsURLConnection

internal fun interface OperatorTransport {
    fun request(parameters: Map<String, String>): String
}

class OutageApi internal constructor(private val transport: OperatorTransport) : OutageSource {
    constructor(context: Context) : this(OperatorHttp(context))

    override fun fetchAddress(address:DictionaryAddress,category:Category,from:LocalDate,to:LocalDate):String{
        require(address.isValid() && from<=to)
        val raw=transport.request(mapOf("op" to "disconn_by_dept","dept_id" to address.departmentId,
            "disconn_selector" to category.selector.toString(),"n_date" to from.format(dateFormat),"k_date" to to.format(dateFormat)))
        return DepartmentOutages.filter(raw,address,category)
    }

    override fun fetch(account: String, category: Category, from: LocalDate, to: LocalDate): String {
        val normalized = AccountNumber.normalize(account)
        require(AccountNumber.isValid(normalized)) { "Особовий рахунок має містити 11 цифр" }
        require(from <= to) { "Некоректний період запиту" }
        return transport.request(mapOf(
            "op" to "disconn_by_ls",
            "disconn_selector" to category.selector.toString(),
            "n_date" to from.format(dateFormat),
            "k_date" to to.format(dateFormat),
            "abon_ls" to normalized
        ))
    }

    companion object {
        private val dateFormat = DateTimeFormatter.ofPattern("dd.MM.uuuu", Locale.ROOT)
    }
}

internal class OperatorHttp(context: Context) : OperatorTransport {
    private val appContext = context.applicationContext

    override fun request(parameters: Map<String, String>): String {
        val connection = requestUrl(parameters).openConnection() as HttpsURLConnection
        try {
            // Keep the platform's hostname verification and system trust anchors enabled.
            connection.sslSocketFactory = ApiTls.socketFactory(appContext)
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15_000
            connection.readTimeout = 20_000
            connection.useCaches = false
            connection.requestMethod = "GET"
            connection.setRequestProperty("Accept", "application/json")
            if (connection.responseCode != HttpsURLConnection.HTTP_OK) {
                throw SourceException(SourceFailure.http(connection.responseCode))
            }
            return connection.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                readResponse(parameters, reader)
            }
        } catch (error: IOException) {
            // Platform exceptions may contain the GET URL, including the personal account.
            throw SourceException(SourceFailure.of(error))
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        private const val ENDPOINT = "https://cabinet.cherkasyoblenergo.com/api_new/disconn.php"
        private const val MAX_RESPONSE_CHARS = 2_000_000
        private const val MAX_DEPARTMENT_RESPONSE_CHARS = 8_000_000

        fun readResponse(parameters: Map<String, String>, reader: Reader): String {
            // A department feed covers thousands of households across the full requested period.
            val limit = if (parameters["op"] == "disconn_by_dept") MAX_DEPARTMENT_RESPONSE_CHARS else MAX_RESPONSE_CHARS
            val result = StringBuilder()
            val buffer = CharArray(8_192)
            while (true) {
                val count = reader.read(buffer)
                if (count < 0) break
                if (result.length + count > limit) throw IOException("Завелика відповідь оператора")
                result.append(buffer, 0, count)
            }
            return result.toString()
        }

        fun requestUrl(parameters: Map<String, String>): URL {
            val query = parameters.entries.joinToString("&") { (name, value) ->
                URLEncoder.encode(name, "UTF-8") + "=" + URLEncoder.encode(value, "UTF-8")
            }
            return URL("$ENDPOINT?$query")
        }
    }
}
