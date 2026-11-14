/* Diagnostic only. Never load into an installed user process. No V8 API. */
#include <node_api.h>
#include <stdint.h>
#include <stddef.h>
#include <unistd.h>
#include <pthread.h>
#include <libproc.h>
#include <sys/sysctl.h>
#include <mach/mach_time.h>

typedef struct { uint64_t instructions, cycles, user_ticks, system_ticks, energy_nj; } level;
typedef struct { uint16_t length, reserved0; uint32_t reserved1; level levels[8]; } counts;
_Static_assert(sizeof(level)==40 && offsetof(counts,levels)==8, "counter ABI");
static int levels;
static uint64_t owner;
#define STRIDE 44
#define CHECK(x) do { if ((x)!=napi_ok) { napi_throw_error(env,0,"owned_counter_napi_failed"); return NULL; } } while(0)
static napi_value write_into(napi_env env,napi_callback_info info) {
  size_t argc=2,length,offset; napi_value argv[2]; napi_typedarray_type type; void *data; napi_value ab; size_t byte_offset;
  CHECK(napi_get_cb_info(env,info,&argc,argv,0,0));
  uint32_t slot; uint64_t tid=0;
  if(argc!=2) { napi_throw_type_error(env,0,"owned_counter_arguments"); return NULL; }
  CHECK(napi_get_value_uint32(env,argv[1],&slot));
  CHECK(napi_get_typedarray_info(env,argv[0],&type,&length,&data,&ab,&byte_offset));
  offset=(size_t)slot*STRIDE;
  if(type!=napi_biguint64_array || offset>length || length-offset<STRIDE || pthread_threadid_np(NULL,&tid)!=0 || tid!=owner) {
    napi_throw_error(env,0,"owned_counter_buffer_or_thread"); return NULL;
  }
  counts c={0}; const int size=8+levels*40; const uint64_t before=mach_absolute_time();
  const int copied=proc_pidinfo(getpid(),34,tid,&c,size); const uint64_t after=mach_absolute_time();
  if(copied!=size || c.length!=levels || c.reserved0 || c.reserved1) { napi_throw_error(env,0,"owned_counter_abi_or_read"); return NULL; }
  uint64_t *out=(uint64_t*)data+offset;
  out[0]=tid;out[1]=levels;out[2]=before;out[3]=after;
  for(int i=0;i<levels;i++){out[4+i*5]=c.levels[i].instructions;out[5+i*5]=c.levels[i].cycles;out[6+i*5]=c.levels[i].user_ticks;out[7+i*5]=c.levels[i].system_ticks;out[8+i*5]=c.levels[i].energy_nj;}
  napi_value result;CHECK(napi_get_undefined(env,&result));return result;
}
static napi_value init(napi_env env,napi_value exports) {
  size_t size=sizeof(levels); mach_timebase_info_data_t tb;
  if(sysctlbyname("hw.nperflevels",&levels,&size,NULL,0)!=0 || size!=sizeof(levels) || levels<1 || levels>8 || pthread_threadid_np(NULL,&owner)!=0 || mach_timebase_info(&tb)!=0 || !tb.denom) {
    napi_throw_error(env,0,"owned_counter_initialization");return NULL;
  }
  napi_property_descriptor p={"writeInto",0,write_into,0,0,0,napi_default,0};CHECK(napi_define_properties(env,exports,1,&p));
  const char *names[]={"stride","levels","numer","denom"}; uint32_t values[]={STRIDE,(uint32_t)levels,tb.numer,tb.denom};
  for(int i=0;i<4;i++){napi_value v;CHECK(napi_create_uint32(env,values[i],&v));CHECK(napi_set_named_property(env,exports,names[i],v));}
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
