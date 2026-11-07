package ua.svitlo.widget.core

enum class RefreshCompletion { SUCCESS, RETRY, FAILURE }
object RefreshPolicy {
    fun completion(accountSucceeded:Boolean,feedSucceeded:Boolean,attempt:Int):RefreshCompletion = when {
        accountSucceeded && feedSucceeded -> RefreshCompletion.SUCCESS
        attempt<2 -> RefreshCompletion.RETRY
        else -> RefreshCompletion.FAILURE
    }
}
