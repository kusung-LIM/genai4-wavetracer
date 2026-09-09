/* ============================ 데이터: 서핑 포인트 ============================
   lat/lon : 해변 실제 위치 (바람·기온 조회용)
   sea     : 파랑 모델 격자에 걸리는 앞바다 좌표 (해상 데이터 조회용)
   facing  : 해변이 바라보는 방위(도). 이 방향에서 너울이 들어온다.
============================================================================ */
const SPOTS = [
  { id:"sampo",    name:"삼포 해변",   region:"강원 고성",   lat:38.2650, lon:128.5620, sea:[38.2650,128.5950], facing:80  },
  { id:"hajodae",  name:"하조대 해변", region:"강원 양양",   lat:38.0480, lon:128.6960, sea:[38.0480,128.7300], facing:85  },
  { id:"jukdo",    name:"죽도 해변",   region:"강원 양양",   lat:38.0158, lon:128.7186, sea:[38.0158,128.7500], facing:85  },
  { id:"ingu",     name:"인구 해변",   region:"강원 양양",   lat:37.9930, lon:128.7290, sea:[37.9930,128.7600], facing:90  },
  { id:"gyeongpo", name:"경포 해변",   region:"강원 강릉",   lat:37.8010, lon:128.9080, sea:[37.8010,128.9400], facing:90  },
  { id:"geumjin",  name:"금진 해변",   region:"강원 강릉",   lat:37.6360, lon:129.0460, sea:[37.6360,129.0750], facing:95  },
  { id:"yonghan",  name:"용한리 해변", region:"경북 포항",   lat:36.1170, lon:129.4090, sea:[36.1170,129.4400], facing:95  },
  { id:"songjeong",name:"송정 해변",   region:"부산 해운대", lat:35.1786, lon:129.1997, sea:[35.1640,129.2130], facing:140 },
  { id:"dadaepo",  name:"다대포 해변", region:"부산 사하",   lat:35.0430, lon:128.9670, sea:[35.0250,128.9670], facing:190 },
  { id:"jungmun",  name:"중문 색달",   region:"제주 서귀포", lat:33.2447, lon:126.4106, sea:[33.2250,126.4106], facing:180 },
  { id:"iho",      name:"이호테우",    region:"제주 제주시", lat:33.4990, lon:126.4530, sea:[33.5200,126.4530], facing:350 },
  { id:"woljeong", name:"월정리 해변", region:"제주 구좌",   lat:33.5560, lon:126.7960, sea:[33.5750,126.7960], facing:5   },
  { id:"malli",    name:"만리포 해변", region:"충남 태안",   lat:36.7889, lon:126.1379, sea:[36.7889,126.1050], facing:270 }
];


/** 스팟 id → 표시 이름. 모르는 id 는 그대로 돌려준다(옛 링크·삭제된 스팟 방어). */
function spotNameOf(id){
  const s = SPOTS.find(x => x.id === id);
  return s ? s.name : id;
}

export { SPOTS, spotNameOf };
