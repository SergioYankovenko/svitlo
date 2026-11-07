package ua.svitlo.widget

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import ua.svitlo.widget.core.*
import java.io.IOException
import java.time.Instant
import java.time.LocalDate

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class RepositoryTest {
    private lateinit var context: Context
    private val firstAccount = "12345678901"
    private val secondAccount = "12345678902"
    private var time = Instant.parse("2026-10-22T06:30:00Z")
    private val raw = """{"DATETIME":"09:30 22.10.2026","DISCONNECTIONS":[],"DISCONN_QUEUQ":[]}"""
    private class FakeSource(private val raw: String) : OutageSource {
        val calls = mutableListOf<Triple<String, LocalDate, LocalDate>>()
        var failing: Set<Category> = emptySet()
        var onFetch: (() -> Unit)? = null
        override fun fetch(account: String, category: Category, from: LocalDate, to: LocalDate): String {
            calls += Triple(account, from, to)
            onFetch?.also { onFetch = null }?.invoke()
            if (category in failing) throw IOException("offline")
            return raw
        }
    }

    @Before fun setup() {
        context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("svitlo_private", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test fun lookupNeverPersistsAccountUntilExplicitAddressConfirmation() {
        val api = FakeSource(raw)
        val repo = OutageRepository(context, api) { time }
        val prepared = repo.prepare(firstAccount)
        assertEquals(3, api.calls.size)
        assertNull(repo.binding())
        assertTrue(repo.snapshot().categories.isEmpty())
        assertTrue(repo.bindConfirmed(firstAccount, "м. Приклад, вул. Тестова, 1", prepared))
        assertEquals(firstAccount, repo.binding()?.account)
        assertEquals(3, repo.snapshot().categories.size)
    }

    @Test fun emptyAddressAndMismatchedPreparedAccountCannotBind() {
        val repo = OutageRepository(context, FakeSource(raw)) { time }
        val prepared = repo.prepare(firstAccount)
        assertFalse(repo.bindConfirmed(firstAccount, "  ", prepared))
        assertFalse(repo.bindConfirmed(secondAccount, "м. Приклад", prepared))
        assertNull(repo.binding())
    }

    @Test fun unboundRefreshDoesNotRequestOrStoreData() {
        val api = FakeSource(raw)
        val repo = OutageRepository(context, api) { time }
        assertEquals(RefreshResult.UNBOUND, repo.refresh())
        assertTrue(api.calls.isEmpty())
        assertTrue(repo.snapshot().categories.isEmpty())
    }

    @Test fun requestsCoverYesterdayThroughTomorrowInKyivTime() {
        val api = FakeSource(raw)
        OutageRepository(context, api) { time }.prepare(firstAccount)
        assertEquals(3, api.calls.size)
        assertTrue(api.calls.all { it.second == LocalDate.parse("2026-10-21") && it.third == LocalDate.parse("2026-10-23") })
    }

    @Test fun categoryFailurePreservesSuccessfulCacheAndMarksItFailed() {
        val api = FakeSource(raw)
        val repo = OutageRepository(context, api) { time }
        repo.bindConfirmed(firstAccount, "м. Приклад", repo.prepare(firstAccount))
        val before = repo.snapshot().categories[Category.EMERGENCY]
        api.failing = setOf(Category.EMERGENCY)
        time = time.plusSeconds(600)
        assertEquals(RefreshResult.PARTIAL_FAILURE, repo.refresh())
        val after = repo.snapshot()
        assertEquals(before, after.categories[Category.EMERGENCY])
        assertEquals(setOf(Category.EMERGENCY), after.failures)
        assertEquals(time, after.categories[Category.PLANNED]?.fetchedAt)
        assertFalse(after.isCompleteAndFresh(time))
    }

    @Test fun accountChangeDuringRefreshDiscardsOldResponseAcrossRepositoryInstances() {
        val api = FakeSource(raw)
        val repo = OutageRepository(context, api) { time }
        val other = OutageRepository(context, FakeSource(raw)) { time }
        repo.bindConfirmed(firstAccount, "Перша адреса", repo.prepare(firstAccount))
        val newPrepared = other.prepare(secondAccount)
        api.onFetch = { other.bindConfirmed(secondAccount, "Друга адреса", newPrepared) }
        assertEquals(RefreshResult.SUPERSEDED, repo.refresh())
        assertEquals(secondAccount, repo.binding()?.account)
        assertEquals("Друга адреса", repo.binding()?.address)
    }

    @Test fun resetDuringRefreshCannotRecreateBindingOrCache() {
        val api = FakeSource(raw)
        val repo = OutageRepository(context, api) { time }
        repo.bindConfirmed(firstAccount, "м. Приклад", repo.prepare(firstAccount))
        api.onFetch = { OutageRepository(context, FakeSource(raw)).clear() }
        assertEquals(RefreshResult.SUPERSEDED, repo.refresh())
        assertNull(repo.binding())
        assertTrue(repo.snapshot().categories.isEmpty())
    }

    @Test fun dayRolloverMarksInsufficientCoverageEvenWhenCachedDataWasRecentlyFetched() {
        time = Instant.parse("2026-10-22T20:59:00Z")
        val api = FakeSource(raw.replace("09:30", "23:59"))
        val repo = OutageRepository(context, api) { time }
        repo.bindConfirmed(firstAccount, "м. Приклад", repo.prepare(firstAccount))
        assertFalse("No queue evidence is not a complete schedule",repo.snapshot().isCompleteAndFresh(time))
        time = time.plusSeconds(120)
        assertEquals(Category.entries.toSet(), repo.snapshot().failures)
    }

    @Test fun confirmedBindingAndSettingsSurviveNewRepositoryInstance() {
        val repo = OutageRepository(context, FakeSource(raw)) { time }
        repo.bindConfirmed(firstAccount, "м. Приклад", repo.prepare(firstAccount))
        repo.setIntervalMinutes(30)
        val reopened = OutageRepository(context, FakeSource(raw)) { time }
        assertEquals(60, reopened.intervalMinutes())
        assertEquals(firstAccount, reopened.binding()?.account)
        assertEquals(3, reopened.snapshot().categories.size)
    }

    @Test fun invalidPreviewAccountMakesNoRequestsAndCannotBind() {
        val api = FakeSource(raw)
        val repo = OutageRepository(context, api) { time }
        assertThrows(IllegalArgumentException::class.java) { repo.prepare("1234567890x") }
        assertTrue(api.calls.isEmpty())
        assertNull(repo.binding())
    }

    @Test fun rebindingSameAccountDuringRefreshStillDiscardsOldResponse() {
        val api = FakeSource(raw)
        val repo = OutageRepository(context, api) { time }
        val other = OutageRepository(context, FakeSource(raw)) { time }
        repo.bindConfirmed(firstAccount, "Перша адреса", repo.prepare(firstAccount))
        val prepared = other.prepare(firstAccount)
        api.onFetch = { other.bindConfirmed(firstAccount, "Підтверджена адреса", prepared) }
        assertEquals(RefreshResult.SUPERSEDED, repo.refresh())
        assertEquals("Підтверджена адреса", repo.binding()?.address)
    }

    @Test fun switchingAccountNeverInheritsFailedCategoryFromPreviousHousehold() {
        val api = FakeSource(raw)
        val repo = OutageRepository(context, api) { time }
        repo.bindConfirmed(firstAccount, "Перша адреса", repo.prepare(firstAccount))
        api.failing = setOf(Category.EMERGENCY)
        assertTrue(repo.bindConfirmed(secondAccount, "Друга адреса", repo.prepare(secondAccount), "м. Приклад"))
        val reopened = OutageRepository(context, api) { time }
        assertFalse(reopened.snapshot().categories.containsKey(Category.EMERGENCY))
        assertEquals(setOf(Category.EMERGENCY), reopened.snapshot().failures)
        assertEquals("м. Приклад", reopened.binding()?.city)
    }

    @Test fun failedStatusAndSuccessfulCachedCategoriesSurviveReopening() {
        val api = FakeSource(raw)
        val repo = OutageRepository(context, api) { time }
        repo.bindConfirmed(firstAccount, "м. Приклад", repo.prepare(firstAccount))
        val previous = repo.snapshot().categories[Category.EMERGENCY]
        api.failing = setOf(Category.EMERGENCY)
        time = time.plusSeconds(60)
        repo.refresh()
        val reopened = OutageRepository(context, api) { time }
        assertEquals(previous, reopened.snapshot().categories[Category.EMERGENCY])
        assertEquals(setOf(Category.EMERGENCY), reopened.snapshot().failures)
    }

    @Test fun failedAccountCommitRestoresOldBindingCacheGenerationAndEveryPreferenceType() {
        val api = FakeSource(raw)
        val original = OutageRepository(context, api) { time }
        assertTrue(original.bindConfirmed(firstAccount, "Перша адреса", original.prepare(firstAccount), "Перше місто"))
        original.setIntervalMinutes(30)
        val prefs = context.getSharedPreferences("svitlo_private", Context.MODE_PRIVATE)
        prefs.edit().putBoolean("test_boolean", true).putFloat("test_float", 1.25f)
            .putLong("test_long", 9_000_000_000L).putStringSet("test_set", setOf("first", "second")).commit()
        val before = prefs.all.toMap()
        val oldSnapshot = original.snapshot()
        val failing = MutatingFailedCommitPreferences(prefs)
        val replacement = OutageRepository(preferencesContext(failing), api) { time.plusSeconds(600) }
        api.failing = setOf(Category.EMERGENCY)

        assertFalse(replacement.bindConfirmed(secondAccount, "Друга адреса", replacement.prepare(secondAccount), "Друге місто"))

        assertEquals("Rollback must restore all values, including the original generation", before, prefs.all)
        assertEquals(ConfirmedBinding(firstAccount, "Перша адреса", "Перше місто"), original.binding())
        assertEquals(oldSnapshot, original.snapshot())
        assertEquals(60, original.intervalMinutes())
        assertEquals("Both the failed save and failed rollback commit must update memory", 2, failing.commits)
    }

    @Test fun failedFirstBindingCannotLeaveAnInMemoryAccountOrCache() {
        val prefs = context.getSharedPreferences("svitlo_private", Context.MODE_PRIVATE)
        prefs.edit().putInt("interval_minutes", 120).commit()
        val before = prefs.all.toMap()
        val repo = OutageRepository(preferencesContext(MutatingFailedCommitPreferences(prefs)), FakeSource(raw)) { time }

        assertFalse(repo.bindConfirmed(firstAccount, "Перша адреса", repo.prepare(firstAccount)))

        assertEquals(before, prefs.all)
        assertNull(OutageRepository(context, FakeSource(raw)).binding())
        assertTrue(repo.snapshot().categories.isEmpty())
    }

    @Test fun failedReplacementDoesNotInvalidateOriginalHouseholdRefreshInFlight() {
        val api = FakeSource(raw)
        val original = OutageRepository(context, api) { time }
        assertTrue(original.bindConfirmed(firstAccount, "Перша адреса", original.prepare(firstAccount)))
        val prefs = context.getSharedPreferences("svitlo_private", Context.MODE_PRIVATE)
        val generation = prefs.getString("generation", null)
        val replacement = OutageRepository(preferencesContext(MutatingFailedCommitPreferences(prefs)), FakeSource(raw)) { time }
        val prepared = replacement.prepare(secondAccount)
        api.onFetch = { assertFalse(replacement.bindConfirmed(secondAccount, "Друга адреса", prepared)) }
        time = time.plusSeconds(600)

        assertEquals(RefreshResult.SUCCESS, original.refresh())

        assertEquals(firstAccount, original.binding()?.account)
        assertEquals(generation, prefs.getString("generation", null))
        assertTrue(original.snapshot().categories.values.all { it.fetchedAt == time })
    }

    private fun preferencesContext(preferences: SharedPreferences): Context = object : ContextWrapper(context) {
        override fun getApplicationContext(): Context = this
        override fun getSharedPreferences(name: String, mode: Int): SharedPreferences =
            if (name == "svitlo_private") preferences else super.getSharedPreferences(name, mode)
    }

    /** Android updates its in-memory map before a disk commit can report failure. */
    private class MutatingFailedCommitPreferences(private val backing: SharedPreferences) : SharedPreferences by backing {
        var commits = 0
            private set

        override fun edit(): SharedPreferences.Editor {
            val editor = backing.edit()
            return object : SharedPreferences.Editor by editor {
                override fun commit(): Boolean {
                    editor.commit()
                    commits++
                    return false
                }
                override fun putString(key: String, value: String?): SharedPreferences.Editor = also { editor.putString(key, value) }
                override fun putStringSet(key: String, values: Set<String>?): SharedPreferences.Editor = also { editor.putStringSet(key, values) }
                override fun putInt(key: String, value: Int): SharedPreferences.Editor = also { editor.putInt(key, value) }
                override fun putLong(key: String, value: Long): SharedPreferences.Editor = also { editor.putLong(key, value) }
                override fun putFloat(key: String, value: Float): SharedPreferences.Editor = also { editor.putFloat(key, value) }
                override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor = also { editor.putBoolean(key, value) }
                override fun remove(key: String): SharedPreferences.Editor = also { editor.remove(key) }
                override fun clear(): SharedPreferences.Editor = also { editor.clear() }
            }
        }
    }
}
