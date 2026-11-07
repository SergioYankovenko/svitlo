package ua.svitlo.widget

import org.junit.Assert.*
import org.junit.Test

class WidgetPinGateTest {
    @Test fun independentWidgetTypesCanEachOpenOneConfirmation(){
        val gate=WidgetPinGate()
        assertNotNull(gate.begin(false,100))
        assertNotNull(gate.begin(true,100))
        assertNull(gate.begin(false,101))
    }
    @Test fun repeatedClicksAndRecreatedActivityCannotStartSecondPendingRequest(){
        val gate=WidgetPinGate()
        assertNotNull(gate.begin(false,100))
        assertNull(gate.begin(false,101))
        assertNotNull(gate.begin(true,101))
    }
    @Test fun launcherReturnClearsCancellationForImmediateRetry(){
        val gate=WidgetPinGate()
        assertNotNull(gate.begin(false,100))
        gate.launcherReturned()
        assertNotNull(gate.begin(false,101))
        assertNull(gate.begin(false,102))
    }
    @Test fun rejectedRequestOrCallbackReleasesPendingAndTimeoutCannotStickForever(){
        val gate=WidgetPinGate()
        val first=gate.begin(false,100)!!;gate.finish(false,first)
        assertNotNull(gate.begin(false,101));assertNull(gate.begin(false,102))
        assertNotNull(gate.begin(false,121_000))
        assertNotNull(gate.begin(true,121_000))
    }
    @Test fun aLateCallbackCannotReleaseTheNextRequest(){
        val gate=WidgetPinGate();val old=gate.begin(true,100)!!
        gate.launcherReturned();val current=gate.begin(true,101)!!
        assertNotEquals(old,current);gate.finish(true,old)
        assertNull(gate.begin(true,102))
        gate.finish(true,current);assertNotNull(gate.begin(true,103))
    }
}
