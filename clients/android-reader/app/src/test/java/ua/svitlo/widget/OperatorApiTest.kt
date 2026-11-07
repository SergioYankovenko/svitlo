package ua.svitlo.widget

import org.junit.Assert.*
import org.junit.Test
import ua.svitlo.widget.core.Category
import java.net.URLDecoder
import java.io.IOException
import java.io.StringReader
import java.time.LocalDate

class OperatorApiTest {
    @Test fun departmentResponsesCanContainTheFullThreeDayFeedAboveTwoMillionCharacters() {
        val raw = "{\"DISCONNECTIONS\":[]}" + " ".repeat(3_400_000)
        assertEquals(raw, OperatorHttp.readResponse(mapOf("op" to "disconn_by_dept"), StringReader(raw)))
    }

    @Test fun accountAndDictionaryResponsesKeepTheirTwoMillionCharacterBound() {
        val raw = "x".repeat(2_000_001)
        for (operation in listOf("disconn_by_ls", "street_list", "unknown", "")) {
            assertThrows(IOException::class.java) {
                OperatorHttp.readResponse(mapOf("op" to operation), StringReader(raw))
            }
        }
        assertEquals(2_000_000, OperatorHttp.readResponse(emptyMap(), StringReader(raw.dropLast(1))).length)
    }

    @Test fun departmentResponsesStillFailAboveTheirEightMillionCharacterBound() {
        val parameters = mapOf("op" to "disconn_by_dept")
        val raw = "x".repeat(8_000_000)
        assertEquals(raw.length, OperatorHttp.readResponse(parameters, StringReader(raw)).length)
        assertThrows(IOException::class.java) { OperatorHttp.readResponse(parameters, StringReader(raw + "x")) }
    }

    @Test fun outageRequestsUseExactOfficialParametersAndNormalizeOnlyWhitespace() {
        val requests = mutableListOf<Map<String, String>>()
        val api = OutageApi { parameters -> requests += parameters; "response" }
        for (category in Category.entries) {
            assertEquals("response", api.fetch("12345 678901", category,
                LocalDate.parse("2026-10-21"), LocalDate.parse("2026-10-23")))
        }
        assertEquals(listOf("0", "1", "2"), requests.map { it["disconn_selector"] })
        assertTrue(requests.all { it["op"] == "disconn_by_ls" && it["abon_ls"] == "12345678901" &&
            it["n_date"] == "21.10.2026" && it["k_date"] == "23.10.2026" })
    }

    @Test fun invalidAccountNeverReachesOperator() {
        var calls = 0
        val api = OutageApi { calls++; "" }
        assertThrows(IllegalArgumentException::class.java) {
            api.fetch("1234x678901", Category.SCHEDULE, LocalDate.now(), LocalDate.now())
        }
        assertEquals(0, calls)
    }

    @Test fun dictionariesAcceptArraysAndIndexKeyedObjects() {
        val requests = mutableListOf<Map<String, String>>()
        val api = AddressApi { p ->
            requests += p
            when (p["op"]) {
                "department_list" -> """[{"ID":10,"NAME":"Філія"}]"""
                "city_list" -> """{"0":{"ID":"20","NAME":"м. Приклад"}}"""
                "street_list" -> """[{"ID":30,"NAME":"вул. Тестова"}]"""
                "house_list" -> """{"0":{"HOUSE":"1/А"},"1":{"HOUSE":"2"}}"""
                else -> error("unexpected request")
            }
        }
        assertEquals(listOf(AddressItem("10", "Філія")), api.departments())
        assertEquals(listOf(AddressItem("20", "м. Приклад")), api.cities("10"))
        assertEquals(listOf(AddressItem("30", "вул. Тестова")), api.streets("20"))
        assertEquals(listOf("1/А", "2"), api.houses("30"))
        assertEquals("10", requests[1]["dept_id"])
        assertEquals("20", requests[2]["city_id"])
        assertEquals("", requests[2]["search_name"])
        assertEquals("30", requests[3]["street_id"])
    }

    @Test fun confirmationRequiresExactAccountAndReturnsOnlyOfficialAddress() {
        val requests = mutableListOf<Map<String, String>>()
        val api = AddressApi { p ->
            requests += p
            """[{"LS":"12345678900","ADDRESS":"Інша адреса"},{"LS":"12345 678901","NAME":"Not an address","ADDRESS":"м. Приклад, вул. Тестова, 1"}]"""
        }
        assertEquals("м. Приклад, вул. Тестова, 1", api.verify("12345678901", "30", "1/А"))
        assertNull(api.verify("12345678902", "30", "1/А"))
        assertEquals(mapOf("op" to "ls_list_by_addr", "street_id" to "30", "house" to "1/А"), requests.first())
    }

    @Test fun missingAndConflictingOfficialAddressesCannotConfirm() {
        for (response in listOf(
            "[]",
            """[{"LS":"12345678901","NAME":"м. Приклад"}]""",
            """[{"LS":"12345678901","ADDRESS":" "}]""",
            """[{"LS":"12345678901","ADDRESS":"Перша адреса"},{"LS":"12345678901","ADDRESS":"Друга адреса"}]"""
        )) {
            assertNull(AddressApi { response }.verify("12345678901", "30", "1"))
        }
    }

    @Test fun malformedDictionaryDoesNotMasqueradeAsEmptySuccess() {
        for (response in listOf("{\"error\":\"server failure\"}", "null", "[{}]", "[1]")) {
            assertThrows(IllegalArgumentException::class.java) { AddressApi { response }.departments() }
        }
    }

    @Test fun addressResolutionUsesOnlyTheSelectedHouseAndCollapsesExactPairs() {
        val requests = mutableListOf<Map<String, String>>()
        for (response in listOf(
            """[{"LS":"12345 678901","ADDRESS":" м. Приклад, вул. Тестова, 1 ","NAME":"Ignored private field"},{"LS":"12345678901","ADDRESS":"м. Приклад, вул. Тестова, 1"}]""",
            """{"0":{"LS":12345678901,"ADDRESS":"м. Приклад, вул. Тестова, 1"}}"""
        )) {
            val api = AddressApi { p -> requests += p; response }
            assertEquals(AddressResolution.Unique(ResolvedAddress("12345678901", "м. Приклад, вул. Тестова, 1")), api.resolve("30", "1/А"))
        }
        assertTrue(requests.all { it == mapOf("op" to "ls_list_by_addr", "street_id" to "30", "house" to "1/А") })
    }

    @Test fun emptyAndAmbiguousAddressResponsesNeverChooseTheFirstAccount() {
        for (response in listOf("[]", "{}")) {
            assertEquals(AddressResolution.Empty, AddressApi { response }.resolve("30", "1"))
        }
        for (response in listOf(
            """[{"LS":"12345678901","ADDRESS":"Одна адреса"},{"LS":"12345678902","ADDRESS":"Одна адреса"}]""",
            """[{"LS":"12345678901","ADDRESS":"Перша адреса"},{"LS":"12345678901","ADDRESS":"Друга адреса"}]"""
        )) {
            assertEquals(AddressResolution.Ambiguous, AddressApi { response }.resolve("30", "1"))
        }
    }

    @Test fun malformedAddressRowsCannotBecomeAnEmptyOrUniqueResolution() {
        val valid = """{"LS":"12345678901","ADDRESS":"Офіційна адреса"}"""
        for (invalid in listOf(
            """{"LS":"12345678902","NAME":"Not an address"}""",
            """{"LS":"12345678902","ADDRESS":" "}""",
            """{"LS":"12345678902","ADDRESS":12}""",
            """{"LS":"123","ADDRESS":"Офіційна адреса"}""",
            """{"LS":null,"ADDRESS":"Офіційна адреса"}""", "null", "1"
        )) {
            for (response in listOf("[$invalid]", "[$valid,$invalid]")) {
                assertThrows(IllegalArgumentException::class.java) { AddressApi { response }.resolve("30", "1") }
            }
        }
        assertThrows(IllegalArgumentException::class.java) { AddressApi { "[]unexpected" }.resolve("30", "1") }
        var calls = 0
        val api = AddressApi { calls++; "[]" }
        assertThrows(IllegalArgumentException::class.java) { api.resolve("", "1") }
        assertThrows(IllegalArgumentException::class.java) { api.resolve("30", " ") }
        assertEquals(0, calls)
    }

    @Test fun queryValuesAreEncodedAndHostCannotBeChanged() {
        val parameters = mapOf("op" to "ls_list_by_addr", "house" to "1/А & 2", "street_id" to "30")
        val url = OperatorHttp.requestUrl(parameters)
        assertEquals("https", url.protocol)
        assertEquals("cabinet.cherkasyoblenergo.com", url.host)
        assertNotNull("Request must include encoded query parameters", url.query)
        val parsed = url.query.split('&').associate { pair ->
            val split = pair.split('=', limit = 2)
            URLDecoder.decode(split[0], "UTF-8") to URLDecoder.decode(split[1], "UTF-8")
        }
        assertEquals(parameters, parsed)
    }
}
