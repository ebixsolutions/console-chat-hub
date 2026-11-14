"""行業分類字典的種子資料（一次性遷移來源）。

原 `industry_groups.INDUSTRY_GROUPS` 常數已遷移至資料庫表 `kb_industry_category`；
本檔只保留「預設字典」原始資料，作為：

- Alembic migration 0008 的匯入來源（建表後冪等寫入）；
- `industry_groups.ensure_seeded()` 的修復來源（表存在但為空時補齊）。

★ 執行期的分類邏輯（標籤查詢 / 規則匹配 / LLM prompt）一律從 DB 讀取，
  不再直接引用本檔。value / label / subcategories 與前端 `IndustryGroups.jsx` 對齊。
"""
from __future__ import annotations

from typing import Any

SEED_INDUSTRY_GROUPS: list[dict[str, Any]] = [
    {
        "label": "家庭電器", "value": "HomeAppliance",
        "subcategories": [
            {"label": "冷氣機", "value": "HomeAppliance_AirCon"},
            {"label": "空氣清淨機/空氣淨化器", "value": "HomeAppliance_AirPurifier"},
            {"label": "雪櫃/冰箱", "value": "HomeAppliance_Fridge"},
            {"label": "洗衣機", "value": "HomeAppliance_WashingMachine"},
            {"label": "電視機", "value": "HomeAppliance_TV"},
            {"label": "抽油煙機", "value": "HomeAppliance_Hood"},
            {"label": "微波爐/焗爐", "value": "HomeAppliance_Microwave"},
            {"label": "熱水器", "value": "HomeAppliance_WaterHeater"},
            {"label": "洗碗機", "value": "HomeAppliance_Dishwasher"},
            {"label": "消毒櫃", "value": "HomeAppliance_Sterilizer"},
            {"label": "電飯煲/壓力鍋", "value": "HomeAppliance_RiceCooker"},
        ],
    },
    {
        "label": "醫藥、食品及保健品", "value": "FoodAndBeverage",
        "subcategories": [
            {"label": "醫藥 OTC/藥品", "value": "OTCMedical"},
            {"label": "保健食品", "value": "FoodAndBeverage_Supplement"},
            {"label": "食品 乾貨/零食", "value": "FoodAndBeverage_DryFood"},
            {"label": "生鮮食品", "value": "FoodAndBeverage_Fresh"},
            {"label": "嬰兒奶粉/食品", "value": "FoodAndBeverage_BabyFood"},
            {"label": "咖啡豆/茶葉", "value": "FoodAndBeverage_Coffee"},
            {"label": "酒類", "value": "FoodAndBeverage_Alcohol"},
            {"label": "烹飪調味品", "value": "FoodAndBeverage_Condiment"},
            {"label": "機能飲品", "value": "FoodAndBeverage_Drink"},
            {"label": "寵物食品", "value": "FoodAndBeverage_PetFood"},
        ],
    },
    {
        "label": "消費電子與個人電子", "value": "ConsumerElectronics",
        "subcategories": [
            {"label": "智能手機", "value": "ConsumerElectronics_Phone"},
            {"label": "筆記型電腦", "value": "ConsumerElectronics_Laptop"},
            {"label": "平板電腦", "value": "ConsumerElectronics_Tablet"},
            {"label": "智能手錶", "value": "ConsumerElectronics_Watch"},
            {"label": "藍牙耳機", "value": "ConsumerElectronics_Earphone"},
            {"label": "相機/攝影機", "value": "ConsumerElectronics_Camera"},
            {"label": "鏡頭", "value": "ConsumerElectronics_Lens"},
            {"label": "行動電源/充電器", "value": "ConsumerElectronics_PowerBank"},
            {"label": "智能家居/監控", "value": "ConsumerElectronics_SmartHome"},
            {"label": "電腦周邊", "value": "ConsumerElectronics_Peripheral"},
        ],
    },
    {
        "label": "時尚成衣與飾品", "value": "FashionAccessories",
        "subcategories": [
            {"label": "成衣/服裝", "value": "FashionAccessories_Clothing"},
            {"label": "手袋/皮具", "value": "FashionAccessories_Bag"},
            {"label": "鞋類", "value": "FashionAccessories_Shoes"},
            {"label": "珠寶/金飾", "value": "FashionAccessories_Jewelry"},
            {"label": "手錶", "value": "FashionAccessories_Watch"},
            {"label": "運動鞋", "value": "FashionAccessories_SportShoes"},
            {"label": "運動服飾", "value": "FashionAccessories_SportWear"},
            {"label": "眼鏡/太陽眼鏡", "value": "FashionAccessories_Glasses"},
            {"label": "童裝/嬰兒服", "value": "FashionAccessories_Kids"},
            {"label": "內衣/襪類", "value": "FashionAccessories_Underwear"},
        ],
    },
    {
        "label": "生活百貨、清潔與家居", "value": "HomeLiving",
        "subcategories": [
            {"label": "家居清潔用品", "value": "HomeLiving_Cleaning"},
            {"label": "洗衣用品", "value": "HomeLiving_Laundry"},
            {"label": "紙品/濕紙巾", "value": "HygieneCareProducts_Paper"},
            {"label": "床上用品", "value": "HomeLiving_Bedding"},
            {"label": "廚具/餐具", "value": "HomeLiving_Kitchenware"},
            {"label": "收納用品", "value": "HomeLiving_Storage"},
            {"label": "燈具", "value": "HomeLiving_Lighting"},
            {"label": "五金工具", "value": "HomeImprovement_Tools"},
            {"label": "個人護理電器", "value": "HomeLiving_PersonalCareAppliance"},
            {"label": "浴室配件", "value": "HomeLiving_Bathroom"},
        ],
    },
    {
        "label": "個人護理及美容", "value": "PersonalCareBeauty",
        "subcategories": [
            {"label": "護膚品", "value": "PersonalCareBeauty_Skincare"},
            {"label": "彩妝", "value": "PersonalCareBeauty_Makeup"},
            {"label": "護髮/洗護", "value": "PersonalCareBeauty_HairCare"},
            {"label": "香氛/香水", "value": "PersonalCareBeauty_Fragrance"},
            {"label": "男士護理", "value": "PersonalCareBeauty_Men"},
            {"label": "美容工具", "value": "PersonalCareBeauty_Tools"},
        ],
    },
    {
        "label": "運動、休閒及其他", "value": "SportsOutdoor",
        "subcategories": [
            {"label": "露營帳篷", "value": "SportsOutdoor_Tent"},
            {"label": "露營桌椅", "value": "SportsOutdoor_CampingFurniture"},
            {"label": "腳踏車/單車", "value": "SportsOutdoor_Bicycle"},
            {"label": "瑜伽用品", "value": "SportsOutdoor_Yoga"},
            {"label": "球類裝備", "value": "SportsOutdoor_Ball"},
            {"label": "水上運動", "value": "SportsOutdoor_Water"},
            {"label": "釣魚具", "value": "SportsOutdoor_Fishing"},
            {"label": "健身大型器械", "value": "SportsOutdoor_Fitness"},
            {"label": "行李箱", "value": "SportsOutdoor_Luggage"},
            {"label": "寵物用品 非食品", "value": "EntertainmentLeisure_Pet"},
            {"label": "樂器", "value": "EntertainmentLeisure_Music"},
            {"label": "辦公家具", "value": "OfficeEducation_Furniture"},
            {"label": "打印機/掃描器", "value": "OfficeEducation_Printer"},
            {"label": "文具用品", "value": "OfficeEducation_Stationery"},
        ],
    },
    {
        "label": "手工及客製化創作", "value": "HandmadeCustom",
        "subcategories": [
            {"label": "手繪油畫/藝術品", "value": "HandmadeCustom_Painting"},
            {"label": "手工陶瓷/陶藝", "value": "HandmadeCustom_Ceramic"},
            {"label": "手工皮具/皮革工藝", "value": "HandmadeCustom_Leather"},
            {"label": "手工蠟燭/香氛", "value": "HandmadeCustom_Candle"},
            {"label": "手工首飾/配件", "value": "HandmadeCustom_Jewelry"},
            {"label": "手工編織/刺繡", "value": "HandmadeCustom_Knitting"},
            {"label": "自家香水/調香", "value": "HandmadeCustom_Perfume"},
            {"label": "手工木藝/木雕", "value": "HandmadeCustom_Wood"},
            {"label": "手工玻璃藝術", "value": "HandmadeCustom_Glass"},
            {"label": "手工布藝/拼布", "value": "HandmadeCustom_Fabric"},
        ],
    },
    {
        "label": "IT 與數碼服務", "value": "ITDigitalServices",
        "subcategories": [
            {"label": "軟體開發/SaaS", "value": "ITDigitalServices_Software"},
            {"label": "網頁/App 設計", "value": "ITDigitalServices_WebDesign"},
            {"label": "IT 維修/支援", "value": "ITDigitalServices_Support"},
            {"label": "雲端/資安服務", "value": "ITDigitalServices_Cloud"},
            {"label": "數碼行銷/SEO", "value": "ITDigitalServices_Marketing"},
        ],
    },
    {
        "label": "住宿及場地租賃", "value": "AccommodationVenueRental",
        "subcategories": [
            {"label": "酒店/民宿", "value": "AccommodationVenueRental_Hotel"},
            {"label": "短租公寓", "value": "AccommodationVenueRental_ShortRent"},
            {"label": "場地租用", "value": "AccommodationVenueRental_Venue"},
            {"label": "辦公室/共用工作空間", "value": "AccommodationVenueRental_CoWork"},
            {"label": "旅遊套餐/旅行社", "value": "AccommodationVenueRental_Travel"},
        ],
    },
    {
        "label": "健身、運動及康健服務", "value": "FitnessSportsWellness",
        "subcategories": [
            {"label": "健身房/瑜伽/舞蹈班", "value": "FitnessSportsWellness_Gym"},
            {"label": "私人教練", "value": "FitnessSportsWellness_PersonalTrainer"},
            {"label": "中醫/按摩/療癒", "value": "FitnessSportsWellness_TCM"},
            {"label": "運動課程/培訓", "value": "FitnessSportsWellness_Coaching"},
            {"label": "游泳/水上活動", "value": "FitnessSportsWellness_Swimming"},
        ],
    },
    {
        "label": "美容、美髮及造型服務", "value": "BeautyGroomingServices",
        "subcategories": [
            {"label": "美容院/皮膚護理", "value": "BeautyGroomingServices_Facial"},
            {"label": "美甲/美睫", "value": "BeautyGroomingServices_Nail"},
            {"label": "髮廊/美髮", "value": "BeautyGroomingServices_Hair"},
            {"label": "眉毛/紋繡", "value": "BeautyGroomingServices_Brow"},
            {"label": "寵物美容", "value": "BeautyGroomingServices_PetGrooming"},
        ],
    },
    {
        "label": "汽車、交通及維修服務", "value": "AutomotiveTransportRepair",
        "subcategories": [
            {"label": "汽車維修/保養", "value": "AutomotiveTransportRepair_CarRepair"},
            {"label": "汽車美容/改裝", "value": "AutomotiveTransportRepair_CarDetailing"},
            {"label": "電單車/電動車維修", "value": "AutomotiveTransportRepair_MotoRepair"},
            {"label": "駕駛學校/考牌", "value": "AutomotiveTransportRepair_DrivingSchool"},
            {"label": "租車服務", "value": "AutomotiveTransportRepair_CarRental"},
        ],
    },
    {
        "label": "家居維修及清潔服務", "value": "HomeRepairCleaningServices",
        "subcategories": [
            {"label": "冷氣清洗/維修", "value": "HomeRepairCleaningServices_AirconService"},
            {"label": "水喉/電力維修", "value": "HomeRepairCleaningServices_Plumbing"},
            {"label": "家居清潔服務", "value": "HomeRepairCleaningServices_Cleaning"},
            {"label": "裝修/室內設計", "value": "HomeRepairCleaningServices_Renovation"},
            {"label": "搬屋/倉儲服務", "value": "HomeRepairCleaningServices_Moving"},
        ],
    },
    {
        "label": "教育、培訓及顧問服務", "value": "EducationTrainingConsulting",
        "subcategories": [
            {"label": "補習/課外輔導", "value": "EducationTrainingConsulting_Tutoring"},
            {"label": "語言培訓", "value": "EducationTrainingConsulting_Language"},
            {"label": "職業技能培訓", "value": "EducationTrainingConsulting_Vocational"},
            {"label": "商業/管理顧問", "value": "EducationTrainingConsulting_Business"},
            {"label": "法律/財務顧問", "value": "EducationTrainingConsulting_Legal"},
        ],
    },
    {
        "label": "行銷、創意及活動服務", "value": "MarketingCreativeEventServices",
        "subcategories": [
            {"label": "攝影/錄影服務", "value": "MarketingCreativeEventServices_Photography"},
            {"label": "平面/品牌設計", "value": "MarketingCreativeEventServices_Design"},
            {"label": "活動策劃/佈置", "value": "MarketingCreativeEventServices_Event"},
            {"label": "社交媒體管理", "value": "MarketingCreativeEventServices_SocialMedia"},
            {"label": "印刷/禮品定制", "value": "MarketingCreativeEventServices_Print"},
        ],
    },
    {
        "label": "飲食、旅遊及寵物本地服務", "value": "FoodTravelPetLocalServices",
        "subcategories": [
            {"label": "餐廳/外賣訂餐", "value": "FoodTravelPetLocalServices_Restaurant"},
            {"label": "寵物寄養/訓練", "value": "FoodTravelPetLocalServices_PetCare"},
            {"label": "旅遊導賞/體驗", "value": "FoodTravelPetLocalServices_TourGuide"},
            {"label": "外賣/速遞平台", "value": "FoodTravelPetLocalServices_Delivery"},
            {"label": "婚禮/宴會統籌", "value": "FoodTravelPetLocalServices_Wedding"},
        ],
    },
]
