package ua.svitlo.widget

import android.content.Context
import android.content.SharedPreferences
import ua.svitlo.widget.core.*
import java.time.Instant
import java.time.LocalDate
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.Executors

fun interface OutageSource {
    fun fetch(account: String, category: Category, from: LocalDate, to: LocalDate): String
    fun fetchAddress(address:DictionaryAddress,category:Category,from:LocalDate,to:LocalDate):String = throw IllegalArgumentException("Адресний запит недоступний")
}
data class ConfirmedBinding(val account: String, val address: String, val city: String = "",val dictionary:DictionaryAddress?=null){
    fun isValid()=address.isNotBlank() && (dictionary==null || dictionary.isValid()) && (AccountNumber.isValid(account) || (account.isEmpty() && dictionary?.isValid()==true && address==dictionary.label && city==dictionary.city))
}
data class BoundSnapshot(val binding:ConfirmedBinding,val generation:String,val snapshot:Snapshot)
data class PreparedCategory(val raw: String, val snapshot: CategorySnapshot)
data class PreparedData(val account: String, val from: LocalDate, val to: LocalDate,
    val categories: Map<Category, PreparedCategory>, val failures: Set<Category>,val dictionary:DictionaryAddress?=null,
    val failureReasons:Map<Category,SourceFailure> = emptyMap())
enum class RefreshResult { UNBOUND, SUCCESS, PARTIAL_FAILURE, SUPERSEDED }

class OutageRepository(context: Context, private val source: OutageSource = OutageApi(context),
    private val now: () -> Instant = { Instant.now() }) {
    private val appContext=context.applicationContext
    private val preferences = context.applicationContext.getSharedPreferences("svitlo_private", Context.MODE_PRIVATE)

    fun binding(): ConfirmedBinding? = synchronized(lock) { readBinding() }
    fun generationToken(): String? = synchronized(lock) { preferences.getString("generation",null) }
    fun boundSnapshot():BoundSnapshot? = synchronized(lock){
        val binding=readBinding() ?: return@synchronized null
        BoundSnapshot(binding,preferences.getString("generation",null).orEmpty(),snapshot())
    }
    fun withCurrentBinding(token:String,action:()->Unit):Boolean=synchronized(lock){
        if(readBinding()==null || preferences.getString("generation",null).orEmpty()!=token)return@synchronized false
        action();true
    }
    fun savedProfileData():Pair<ConfirmedBinding,PreparedData>?=synchronized(lock){
        val binding=readBinding() ?: return@synchronized null
        val snapshot=snapshot()
        val prepared=Category.entries.mapNotNull{category->
            val data=snapshot.categories[category] ?: return@mapNotNull null
            val raw=preferences.getString("${key(category)}_raw",null) ?: return@mapNotNull null
            category to PreparedCategory(raw,data)
        }.toMap()
        val from=Category.entries.mapNotNull{runCatching{LocalDate.parse(preferences.getString("${key(it)}_from",null))}.getOrNull()}.minOrNull()
        val to=Category.entries.mapNotNull{runCatching{LocalDate.parse(preferences.getString("${key(it)}_to",null))}.getOrNull()}.maxOrNull()
        val today=now().atZone(KYIV_ZONE).toLocalDate()
        binding to PreparedData(binding.account,from ?: today.minusDays(1),to ?: today.plusDays(1),prepared,snapshot.failures,binding.dictionary)
    }

    /** Fetching preview data cannot create or modify an account binding. */
    fun prepare(account: String,dictionary:DictionaryAddress?=null): PreparedData {
        val normalized = AccountNumber.normalize(account)
        require(AccountNumber.isValid(normalized)) { "Особовий рахунок має містити 11 цифр" }
        require(dictionary==null || dictionary.isValid())
        return prepareSources(normalized,dictionary)
    }
    /** The address key is metadata/fallback; a confirmed account always keeps personal categories. */
    fun prepare(binding:ConfirmedBinding):PreparedData {
        require(binding.isValid())
        return if(binding.account.isNotEmpty())prepare(binding.account,binding.dictionary)else prepareAddress(requireNotNull(binding.dictionary))
    }
    fun prepareAddress(address:DictionaryAddress):PreparedData{
        require(address.isValid())
        return prepareSources("",address)
    }
    private fun prepareSources(normalized:String,dictionary:DictionaryAddress?):PreparedData{
        val day = now().atZone(KYIV_ZONE).toLocalDate()
        val from = day.minusDays(1)
        val to = day.plusDays(1)
        val categories = mutableMapOf<Category, PreparedCategory>()
        val failures = mutableSetOf<Category>()
        val reasons = mutableMapOf<Category,SourceFailure>()
        // Workers return immutable results; only this calling thread owns the maps.
        val pool=Executors.newFixedThreadPool(Category.entries.size)
        val tasks=Category.entries.associateWith { category -> pool.submit(Callable {
            runCatching {
                val raw=if(normalized.isNotEmpty())source.fetch(normalized,category,from,to)else source.fetchAddress(requireNotNull(dictionary),category,from,to)
                PreparedCategory(raw,OutageParser.parse(raw,category,now()))
            }
        }) }
        try {
            for ((category, task) in tasks) {
                val result=task.get()
                result.onSuccess{categories[category]=it}.onFailure { failure ->
                    if(failure is InterruptedException)throw failure
                    failures+=category
                    reasons[category]=SourceFailure.of(failure)
                }
            }
        } catch (interrupted:InterruptedException) {
            tasks.values.forEach{it.cancel(true)}
            Thread.currentThread().interrupt()
            throw interrupted
        } finally {
            pool.shutdownNow()
        }
        return PreparedData(normalized, from, to, categories, failures,dictionary,reasons)
    }

    /** The caller must first match the official address and receive explicit user confirmation. */
    fun bindConfirmed(account: String, address: String, preparedData: PreparedData, city: String = "",dictionary:DictionaryAddress?=null): Boolean {
        val normalized = AccountNumber.normalize(account)
        if (!ConfirmedBinding(normalized,address.trim(),city.trim(),dictionary).isValid() || preparedData.account != normalized || preparedData.dictionary!=dictionary) return false
        return synchronized(lock) {
            val previous = preferences.all.mapValues { (_, value) ->
                if (value is Set<*>) value.toSet() else value
            }
            val editor = preferences.edit()
                .putString("account", normalized)
                .putString("address", address.trim())
                .putString("city", city.trim())
                .putString("dictionary",dictionary?.json()?.toString())
                .putString("generation", UUID.randomUUID().toString())
            // An account change must never inherit a previous household's successful data.
            Category.entries.forEach { clearCategory(editor, it) }
            storePrepared(editor, preparedData)
            if (editor.commit()) {
                InboxRepository(appContext).clearLocal()
                appContext.getSharedPreferences("svitlo_runtime",Context.MODE_PRIVATE).edit().remove("address_attempt").remove("feed_attempt").remove("weather_attempt").commit()
                true
            } else {
                // Android updates memory before committing to disk. Restore the old
                // generation too, so requests for the unchanged account remain valid.
                restorePreferences(previous)
                false
            }
        }
    }

    private fun restorePreferences(previous: Map<String, *>) {
        try {
            val editor = preferences.edit().clear()
            previous.forEach { (key, value) ->
                when (value) {
                    is String -> editor.putString(key, value)
                    is Boolean -> editor.putBoolean(key, value)
                    is Int -> editor.putInt(key, value)
                    is Long -> editor.putLong(key, value)
                    is Float -> editor.putFloat(key, value)
                    is Set<*> -> {
                        @Suppress("UNCHECKED_CAST")
                        editor.putStringSet(key, value as Set<String>)
                    }
                }
            }
            // A second disk failure still restores Android's in-memory values.
            editor.commit()
        } catch (_: Exception) {
            // Restoration is best effort; the failed binding must never report success.
        }
    }

    fun snapshot(): Snapshot = synchronized(lock) {
        if (readBinding() == null) return@synchronized Snapshot(emptyMap(), Category.entries.toSet())
        val checkedNow=now()
        val today = checkedNow.atZone(KYIV_ZONE).toLocalDate()
        val categories = mutableMapOf<Category, CategorySnapshot>()
        val failures = mutableSetOf<Category>()
        for (category in Category.entries) {
            val key = key(category)
            try {
                val raw = preferences.getString("${key}_raw", null)
                    ?: throw IllegalArgumentException("Дані ще не отримано")
                val fetchedAt = Instant.ofEpochMilli(preferences.getLong("${key}_fetched", 0))
                categories[category] = OutageParser.parse(raw, category, fetchedAt)
                val from = LocalDate.parse(preferences.getString("${key}_from", ""))
                val to = LocalDate.parse(preferences.getString("${key}_to", ""))
                if (preferences.getBoolean("${key}_failed", false) ||
                    from > today.minusDays(1) || to < today.plusDays(1)) failures += category
            } catch (_: Exception) {
                failures += category
            }
        }
        enrich(readBinding()!!,categories,failures,checkedNow)
    }

    fun profileSnapshot(binding:ConfirmedBinding,data:PreparedData):Snapshot {
        require(data.account==binding.account && data.dictionary==binding.dictionary){"Дані не відповідають підтвердженій адресі"}
        val at=now();val today=at.atZone(KYIV_ZONE).toLocalDate()
        val failures=data.failures.toMutableSet()
        if(data.from>today.minusDays(1) || data.to<today.plusDays(1))failures+=Category.entries
        return enrich(binding,data.categories.mapValues{it.value.snapshot},failures,at)
    }
    private fun enrich(binding:ConfirmedBinding,categories:Map<Category,CategorySnapshot>,failures:Set<Category>,checkedNow:Instant):Snapshot {
        val apiExcluded=binding.account.isNotEmpty() && Snapshot(categories,failures).apiHourlyExclusion(checkedNow)
        val registry=if(apiExcluded)null else binding.dictionary?.let{QueueRegistryRepository(appContext).cached(it,checkedNow)}
        val excluded=binding.dictionary?.let{QueueRegistryRepository(appContext).excluded(it,checkedNow)}==true
        val address=Snapshot(categories, failures,registryQueue=registry?.queue,queueProvenance=registry?.description(),hourlyExcluded=apiExcluded || excluded)
        val queue=address.queueLabel()
        val feed=OfficialScheduleRepository(appContext).snapshot()
        val plans=feed.days.filter{it.queue==queue}.map{day->
            PublishedPlan(day.date,day.queue,day.intervals.map{span->
                Outage(Category.SCHEDULE,span.start,span.end,false,"Опубліковано","ГПВ · офіційна публікація")
            },day.publishedAt,day.fetchedAt,day.sourceUrl,day.revision,day.cancelled,day.uncertain)
        }
        // For a known queue, an empty address response is incomplete until the independent
        // official publications source has also been successfully checked recently.
        val publicCheckFresh=feed.checkedAt?.let{it>=checkedNow.minusSeconds(7200) && it<=checkedNow.plusSeconds(300)}==true
        val policy=EmergencyPolicy(feed.emergencies,queue,feed.checkedAt,feed.failed || !publicCheckFresh)
        val merged=ScheduleFusion.merge(address,plans,checkedNow,queue!=null && (feed.failed || !publicCheckFresh))
        return merged.copy(emergency=policy,effectiveEvents=policy.filterHourly(merged.allEvents(),merged.plans))
    }

    fun refresh(): RefreshResult {
        val start = synchronized(lock) {
            val binding = readBinding() ?: return RefreshResult.UNBOUND
            binding to preferences.getString("generation", null)
        }
        val prepared = prepare(start.first)
        return synchronized(lock) {
            if (readBinding() != start.first ||
                preferences.getString("generation", null) != start.second) return@synchronized RefreshResult.SUPERSEDED
            val saved = preferences.edit().also { storePrepared(it, prepared) }.commit()
            if (saved && prepared.failures.isEmpty()) RefreshResult.SUCCESS else RefreshResult.PARTIAL_FAILURE
        }
    }

    fun storeProfileRefresh(binding:ConfirmedBinding,token:String?,data:PreparedData):Boolean=synchronized(lock){
        if(data.account!=binding.account || data.dictionary!=binding.dictionary)return@synchronized false
        if(readBinding()!=binding || preferences.getString("generation",null)!=token)return@synchronized false
        preferences.edit().also{storePrepared(it,data)}.commit()
    }

    fun clear() = synchronized(lock) {
        preferences.edit().clear().putString("generation", UUID.randomUUID().toString()).commit()
        OfficialScheduleRepository(appContext).clear()
        InboxRepository(appContext).clearLocal()
        Unit
    }

    fun intervalMinutes(): Int = synchronized(lock) {
        // Also migrates old 30/120-minute schedules before WorkManager UPDATE.
        if(preferences.getInt("interval_minutes",60)!=60)preferences.edit().putInt("interval_minutes",60).commit()
        60
    }

    fun sourceFailure():SourceFailure? = synchronized(lock){
        Category.entries.firstNotNullOfOrNull { category ->
            if(preferences.getBoolean("${key(category)}_failed",false))
                runCatching{SourceFailure.valueOf(preferences.getString("${key(category)}_error",null).orEmpty())}.getOrDefault(SourceFailure.UNREACHABLE)
            else null
        }
    }

    fun setIntervalMinutes(value: Int) = synchronized(lock) {
        require(value in intervals) { "Невідомий інтервал оновлення" }
        preferences.edit().putInt("interval_minutes", 60).commit()
        Unit
    }

    private fun readBinding(): ConfirmedBinding? {
        val account = preferences.getString("account", null) ?: return null
        val address = preferences.getString("address", null) ?: return null
        val dictionary=runCatching{DictionaryAddress.parse(org.json.JSONObject(preferences.getString("dictionary",null) ?: return@runCatching null))}.getOrNull()
        return ConfirmedBinding(account,address,preferences.getString("city", "").orEmpty(),dictionary).takeIf{it.isValid()}
    }

    private fun storePrepared(editor: SharedPreferences.Editor, prepared: PreparedData) {
        for (category in Category.entries) {
            val key = key(category)
            val data = prepared.categories[category]
            editor.putBoolean("${key}_failed", category in prepared.failures || data == null)
            if(category in prepared.failures || data==null)editor.putString("${key}_error",(prepared.failureReasons[category] ?: SourceFailure.UNREACHABLE).name)
            else editor.remove("${key}_error")
            if (data != null) {
                editor.putString("${key}_raw", data.raw)
                    .putLong("${key}_fetched", data.snapshot.fetchedAt.toEpochMilli())
                    .putString("${key}_from", prepared.from.toString())
                    .putString("${key}_to", prepared.to.toString())
            }
        }
    }

    private fun clearCategory(editor: SharedPreferences.Editor, category: Category) {
        val key = key(category)
        listOf("raw", "fetched", "from", "to", "failed", "error").forEach { editor.remove("${key}_$it") }
    }

    companion object {
        // Activity, receiver and worker repositories share this lock in the app's single process.
        // The persisted generation also detects reset/rebind while a request is in flight.
        private val lock = Any()
        private val intervals = setOf(30, 60, 120)
        private fun key(category: Category): String = "category_${category.selector}"
    }
}
