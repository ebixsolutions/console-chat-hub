import postgres from 'npm:postgres@3.4.5';
import {createHandler} from './runtime.mjs';
// TLS validation is mandatory. Never log driver errors, URLs, headers or input.
const connect = url => postgres(url,{prepare:false,max:1,connect_timeout:5,idle_timeout:5,
  ssl:{rejectUnauthorized:true},onnotice:()=>{},debug:false});
Deno.serve(createHandler(name=>Deno.env.get(name),connect,(url,init)=>fetch(url,init)));
