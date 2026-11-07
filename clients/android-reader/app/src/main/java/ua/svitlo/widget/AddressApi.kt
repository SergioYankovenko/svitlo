package ua.svitlo.widget

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import ua.svitlo.widget.core.AccountNumber

data class AddressItem(val id: String, val name: String)
data class ResolvedAddress(val account: String, val address: String)
sealed interface AddressResolution {
    data class Unique(val value: ResolvedAddress) : AddressResolution
    data object Empty : AddressResolution
    data object Ambiguous : AddressResolution
}

class AddressApi internal constructor(private val transport: OperatorTransport) {
    constructor(context: Context) : this(OperatorHttp(context))

    fun departments(): List<AddressItem> = dictionary(mapOf("op" to "department_list"))

    fun cities(dept: String): List<AddressItem> {
        require(dept.isNotBlank()) { "Оберіть філію" }
        return dictionary(mapOf("op" to "city_list", "dept_id" to dept))
    }

    fun streets(city: String): List<AddressItem> {
        require(city.isNotBlank()) { "Оберіть населений пункт" }
        return dictionary(mapOf("op" to "street_list", "city_id" to city, "search_name" to ""))
    }

    fun houses(street: String): List<String> {
        require(street.isNotBlank()) { "Оберіть вулицю" }
        return rows(transport.request(mapOf("op" to "house_list", "street_id" to street, "search_name" to "")))
            .map { text(it, "HOUSE") }.distinct()
    }

    /** Resolve only this house. NAME is neither retained nor used to identify a household. */
    fun resolve(street: String, house: String): AddressResolution {
        require(street.isNotBlank() && house.isNotBlank()) { "Оберіть вулицю та будинок" }
        val pairs = rows(transport.request(mapOf(
            "op" to "ls_list_by_addr", "street_id" to street, "house" to house
        ))).map { row ->
            val account = AccountNumber.normalize(text(row, "LS"))
            val address = (row.opt("ADDRESS") as? String)?.trim()
            require(AccountNumber.isValid(account) && !address.isNullOrEmpty()) { "Некоректний запис адреси" }
            ResolvedAddress(account, address)
        }.distinct()
        return when (pairs.size) {
            0 -> AddressResolution.Empty
            1 -> AddressResolution.Unique(pairs.single())
            else -> AddressResolution.Ambiguous
        }
    }

    /** No account or address is stored. Only the exact account's official ADDRESS may confirm it. */
    fun verify(account: String, street: String, house: String): String? {
        val normalized = AccountNumber.normalize(account)
        if (!AccountNumber.isValid(normalized) || street.isBlank() || house.isBlank()) return null
        val matching = rows(transport.request(mapOf(
            "op" to "ls_list_by_addr", "street_id" to street, "house" to house
        ))).filter { AccountNumber.normalize(it.opt("LS")?.toString().orEmpty()) == normalized }
        if (matching.isEmpty()) return null
        val addresses = matching.map { (it.opt("ADDRESS") as? String)?.trim().orEmpty() }
        if (addresses.any { it.isEmpty() }) return null
        return addresses.distinct().singleOrNull()
    }

    private fun dictionary(parameters: Map<String, String>): List<AddressItem> =
        rows(transport.request(parameters)).map { AddressItem(text(it, "ID"), text(it, "NAME")) }.distinct()

    private fun rows(raw: String): List<JSONObject> {
        try {
            val parser = JSONTokener(raw)
            val value = parser.nextValue()
            require(parser.nextClean() == '\u0000') { "Зайві дані у відповіді" }
            return when (value) {
                is JSONArray -> (0 until value.length()).map { index ->
                    value.optJSONObject(index) ?: throw IllegalArgumentException("Некоректний запис довідника")
                }
                is JSONObject -> value.keys().asSequence().map { key ->
                    value.optJSONObject(key) ?: throw IllegalArgumentException("Некоректний запис довідника")
                }.toList()
                else -> throw IllegalArgumentException("Некоректний довідник оператора")
            }
        } catch (_: Exception) {
            throw IllegalArgumentException("Не вдалося прочитати довідник оператора")
        }
    }

    private fun text(row: JSONObject, key: String): String {
        val value = row.opt(key)
        require(value is String || value is Number) { "Некоректний запис довідника" }
        return value.toString().trim().also { require(it.isNotEmpty()) { "Порожній запис довідника" } }
    }
}
