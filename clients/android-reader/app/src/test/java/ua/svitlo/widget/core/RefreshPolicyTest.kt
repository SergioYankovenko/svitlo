package ua.svitlo.widget.core

import org.junit.Assert.*
import org.junit.Test

class RefreshPolicyTest {
    @Test fun partialAccountFailureIsRetried(){assertEquals(RefreshCompletion.RETRY,RefreshPolicy.completion(false,true,0))}
    @Test fun failedFeedDoesNotReportOverallSuccess(){assertEquals(RefreshCompletion.RETRY,RefreshPolicy.completion(true,false,0))}
    @Test fun repeatedFailuresStopRetryingButRemainFailures(){assertEquals(RefreshCompletion.FAILURE,RefreshPolicy.completion(false,false,2))}
    @Test fun completeRefreshSucceeds(){assertEquals(RefreshCompletion.SUCCESS,RefreshPolicy.completion(true,true,0))}
}
