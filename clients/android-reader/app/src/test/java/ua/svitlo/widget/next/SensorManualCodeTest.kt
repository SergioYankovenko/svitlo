package ua.svitlo.widget.next

import org.junit.Assert.*
import org.junit.Test

class SensorManualCodeTest {
    @Test fun sixDigitsPreserveLeadingZero() {
        val qr=SensorPolicy.qr(" 042715 ")
        assertEquals("phone_code",qr.getString("kind"))
        assertEquals("042715",qr.getString("code"))
        assertEquals(qr.toString(),SensorPolicy.qr(qr.toString()).toString())
    }
    @Test fun rejectNonSixDigitAndMalformedCodes() {
        for(raw in listOf("12345","1234567","12 3456","１２３４５６","https://example.test/123456",
            "{\"version\":1,\"kind\":\"phone_code\",\"code\":123456}",
            "{\"version\":1,\"kind\":\"phone_code\",\"code\":\"042715\",\"proof\":\"extra\"}")) {
            assertTrue(runCatching { SensorPolicy.qr(raw) }.isFailure)
        }
    }
    @Test fun legacyQrKindsRemainSupported() {
        for((kind,prefix) in listOf("phone_owner" to "sp_","factory_owner" to "so_","viewer_invite" to "si_")) {
            val raw="{\"version\":1,\"kind\":\"$kind\",\"sensorId\":\"90007015-2aa3-4f3e-9be2-44624573d217\",\"proof\":\"$prefix${"A".repeat(43)}\"}"
            assertEquals(kind,SensorPolicy.qr(raw).getString("kind"))
        }
    }
}
