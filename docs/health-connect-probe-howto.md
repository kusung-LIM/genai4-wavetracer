# Health Connect 실측 방법 (Phase 2b-1)

> 목적: 삼성헬스가 "서핑"으로 기록한 운동이 Health Connect 에 동기화될 때
> **GPS 경로(route, 위경도 시퀀스)까지 같이 들어오는지** 확인한다.
> 이 문서 하나만 보고 실행할 수 있게 적는다 — 확인이 끝나면 결과를
> `docs/gps-tracker-plan.md` 의 Phase 2b 절에 옮겨 적을 것.

이건 코드 작성이 아니라 **실측**이다. 안드로이드 스튜디오로 앱을 하나 빌드해
본인 폰에 설치하고, 화면(또는 로그)에 찍히는 결과를 보고 판단한다. 에뮬레이터로는
안 된다 — 실제 워치→삼성헬스 동기화 데이터가 있어야 의미가 있다.

## 0. 사전 준비 (여기서 막히면 코드 이전 단계 문제)

1. **삼성헬스 → Health Connect 동기화가 켜져 있는지 확인.**
   삼성헬스 앱 → 설정(우측 상단 톱니) → "Health Connect와 데이터 공유" 또는
   "연결된 서비스" 안에 Health Connect 항목 → 켜져 있는지, 그리고 **"운동"
   카테고리가 공유 대상에 포함돼 있는지** 확인. (문구는 삼성헬스 버전마다
   조금씩 다르다 — "Health Connect" 라는 단어로 검색하듯 찾으면 된다.)
2. **Health Connect 앱 자체가 폰에 있는지 확인.**
   안드로이드 14 이상이면 설정 앱 안에 "Health Connect" 메뉴가 이미 있다.
   그 이하 버전이면 Play 스토어에서 "Health Connect" 앱을 따로 설치해야 한다.
3. 이미 갤럭시워치로 기록해둔 **"서핑" 운동이 하나 이상** 있어야 한다
   (Phase 1 실측 때 만든 기록을 그대로 써도 된다).
4. Android Studio 설치, USB로 폰 연결(개발자 옵션 → USB 디버깅 켜기).

1번이 꺼져 있으면 이 밑의 어떤 코드를 돌려도 Health Connect 쪽에 애초에
데이터가 없어서 결과가 항상 "기록 없음"으로 나온다 — 코드 문제로 착각하지
않도록 가장 먼저 확인할 것.

## 1. 방법 A (추천): 구글 공식 샘플 앱으로 확인

직접 짠 코드보다 이미 컴파일·동작이 보장된 코드로 확인하는 편이 안전하다.
GitHub 에서 `android/health-samples` 리포지토리를 검색하면 Google이 공식으로
관리하는 Health Connect 샘플 프로젝트가 있다(정확한 하위 폴더 경로는 리포
구조가 바뀔 수 있으니, 리포 안에서 "HealthConnect" 가 들어간 모듈을 찾으면 된다).

1. 그 샘플 프로젝트를 클론해 Android Studio 로 연다.
2. 권한 목록에 **운동(Exercise) 읽기**와 **운동 경로(Exercise Routes) 읽기**가
   포함돼 있는지 확인한다 — 샘플에 기본으로 있을 가능성이 높지만, 없다면
   아래 2절의 권한 두 줄을 참고해 추가한다.
3. 앱을 폰에 설치해 실행하고, 권한 요청 화면에서 전부 허용한다.
4. 샘플 앱의 "운동 기록 읽기/조회" 관련 화면으로 들어가 최근 기록 목록을 본다.
5. 삼성헬스로 기록한 "서핑" 항목을 찾는다 (종류가 Surfing 이 아니라
   "기타 운동(Other Workout)" 등으로 다르게 표시될 수도 있다 — 이것도
   중요한 관찰 결과다, 아래 "결과 해석" 참고).
6. 그 항목의 상세를 열었을 때 **경로(route)/지도가 보이는지, 위경도 좌표
   개수가 몇 개인지** 확인한다.

샘플에 경로를 직접 보여주는 화면이 없다면, 아래 2절의 코드 조각을 그 샘플
프로젝트 안에 살짝 끼워 넣어 로그로 찍어보는 쪽이 빠르다.

## 2. 방법 B: 최소 코드 직접 작성 (참고용)

방법 A가 여의치 않을 때 쓰는 대안이다. **아래 코드는 제가 기억으로 재구성한
것이라 API 이름이 라이브러리 버전과 정확히 안 맞을 수 있다** — 이 환경엔
안드로이드 빌드 도구가 없어 제가 직접 컴파일해 확인할 방법이 없다. Android
Studio가 빨간 줄로 표시하는 부분은 Alt+Enter(자동 import/자동완성)로 맞는
이름을 찾아가며 진행하면 된다. 검증하려는 것은 "이 API 이름이 정확한가"가
아니라 "Health Connect에 서핑 세션의 GPS 경로가 들어있는가"이므로, 코드가
정확히 이대로 안 돌아가도 같은 뼈대로 조금만 고치면 된다.

**Android Studio 새 프로젝트**: "Empty Views Activity", 언어 Kotlin,
Minimum SDK 26 이상으로 생성.

**`app/build.gradle.kts` 의 `dependencies` 블록에 추가**:
```kotlin
implementation("androidx.health.connect:connect-client:1.1.0-alpha07")
// 버전 숫자는 Android Studio 가 "최신 안정 버전 쓰기"를 제안하면 그걸 따라도 된다.
```

**`AndroidManifest.xml`**, `<application>` 태그 밖(또는 안, 버전에 따라
Android Studio가 위치를 제안한다)에 추가:
```xml
<uses-permission android:name="android.permission.health.READ_EXERCISE" />
<uses-permission android:name="android.permission.health.READ_EXERCISE_ROUTES" />
```

**`MainActivity.kt`** (기존 생성된 파일 내용을 통째로 교체):
```kotlin
package com.example.hctest

import android.os.Bundle
import android.widget.TextView
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.ExerciseRouteResult
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.temporal.ChronoUnit

class MainActivity : ComponentActivity() {

    private val healthConnectClient by lazy { HealthConnectClient.getOrCreate(this) }

    private val PERMISSIONS = setOf(
        HealthPermission.getReadPermission(ExerciseSessionRecord::class),
        HealthPermission.PERMISSION_READ_EXERCISE_ROUTES,
    )

    private lateinit var output: TextView

    private val requestPermissions =
        registerForActivityResult(PermissionController.createRequestPermissionResultContract()) { granted ->
            if (granted.containsAll(PERMISSIONS)) {
                log("권한 승인됨. 최근 30일 운동 기록 조회 중...")
                queryExercises()
            } else {
                log("권한 일부/전부 거부됨: $granted")
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        output = TextView(this).apply { textSize = 13f; setPadding(28, 28, 28, 28) }
        setContentView(output)

        val status = HealthConnectClient.getSdkStatus(this)
        if (status != HealthConnectClient.SDK_AVAILABLE) {
            log("Health Connect 사용 불가 (status=$status). Health Connect 앱 설치 여부를 확인하세요.")
            return
        }

        lifecycleScope.launch {
            val granted = healthConnectClient.permissionController.getGrantedPermissions()
            if (granted.containsAll(PERMISSIONS)) queryExercises()
            else requestPermissions.launch(PERMISSIONS)
        }
    }

    private fun queryExercises() {
        lifecycleScope.launch {
            val request = ReadRecordsRequest(
                recordType = ExerciseSessionRecord::class,
                timeRangeFilter = TimeRangeFilter.between(
                    Instant.now().minus(30, ChronoUnit.DAYS),
                    Instant.now(),
                ),
            )
            val response = healthConnectClient.readRecords(request)
            log("최근 30일 운동 기록 ${response.records.size}건")

            for (rec in response.records) {
                log("---")
                // exerciseType 숫자를 그대로 찍는다 — 삼성헬스의 "서핑"이
                // Health Connect 안에서 뭘로 매핑됐는지가 그 자체로 확인 대상이다.
                log("exerciseType=${rec.exerciseType}  title=${rec.title}  ${rec.startTime}~${rec.endTime}")
                when (val routeResult = rec.exerciseRouteResult) {
                    is ExerciseRouteResult.Data ->
                        log("  → 경로 있음. 포인트 수: ${routeResult.exerciseRoute.route.size}")
                    is ExerciseRouteResult.NoData ->
                        log("  → 경로 없음(NoData)")
                    is ExerciseRouteResult.ConsentRequired ->
                        log("  → 경로 열람에 개별 동의 필요(ConsentRequired). " +
                            "ExerciseRouteRequestContract 로 개별 요청하는 흐름을 추가해야 함(공식 샘플 참고).")
                    else ->
                        log("  → 알 수 없는 상태: $routeResult")
                }
            }
            if (response.records.isEmpty()) {
                log("기록이 0건이면: 0절의 '삼성헬스 → Health Connect 동기화' 설정이 꺼져 있을 가능성이 가장 크다.")
            }
        }
    }

    private fun log(msg: String) {
        runOnUiThread { output.append(msg + "\n") }
        Log.d("HCTest", msg)
    }
}
```

USB로 연결한 폰에 Run(▶) 하면 앱이 뜨고, 권한 창이 나오면 전부 허용한다.
화면에 찍히는 텍스트(또는 Logcat 에서 태그 `HCTest` 필터)를 읽으면 된다.

## 3. 결과 해석 / 통과 기준

| 화면에 뜨는 것 | 의미 | 다음 행동 |
|---|---|---|
| 서핑 기록에 `경로 있음, 포인트 수: N` (N > 0) | **통과.** Health Connect 로 GPS 경로를 받을 수 있다 | Phase 2b-2(네이티브 앱 개발) 착수 |
| `경로 열람에 개별 동의 필요(ConsentRequired)` | 데이터는 있지만 레코드별로 별도 동의 화면이 한 번 더 필요 | 여전히 통과 — 실제 앱(2b-2)에 그 동의 흐름만 추가하면 됨 |
| `경로 없음(NoData)` | 삼성헬스가 이 운동을 경로 없이 요약만 동기화함 | **탈락.** Health Connect 경로 아님 — 계획 문서의 "route 가 비어있다면" 분기로 이동 |
| 기록 자체가 0건 | 동기화 설정이 꺼져 있거나 아직 동기화 안 됨 | 0절부터 다시 확인 (코드 문제 아님) |
| `exerciseType` 이 서핑과 무관한 값(예: 기타 운동) | 삼성헬스의 "서핑" 라벨이 Health Connect 표준 타입으로 안 넘어옴 | 경로 유무와는 별개 문제 — 라벨로 필터링하는 대신 "가장 최근 운동"처럼 다르게 걸러야 할 수 있음, 메모해둘 것 |

확인이 끝나면 이 표에서 어떤 줄에 해당했는지를 `docs/gps-tracker-plan.md` 의
"🔴 실측 필요" 절 밑에 결과로 적어 넣는다(Phase 1 실측 결과를 기록한 방식과
동일하게).
