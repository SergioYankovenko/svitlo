package ua.svitlo.widget.core

/** Explicit synthetic address evidence for tests of a complete, verified schedule.
 * Unknown-queue tests must keep queueInfo empty; a transport success alone is insufficient. */
fun testQueue(category:Category):List<String> = if(category==Category.SCHEDULE)
    listOf("Графік погодинних відключень: 3 черга 2 підчерга") else emptyList()
